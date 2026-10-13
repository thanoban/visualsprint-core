import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  databasePool,
  migrate,
  assertRuntimeRole,
  AppError,
  type Actor,
} from "@visualsprint/platform";
import { IntelligenceService } from "../../src/application/intelligence.js";
import { EvidenceIndexing } from "../../src/application/indexing.js";
import { IndexedChatEvidence } from "../../src/application/indexed-chat.js";
import { PostgresIntelligence } from "../../src/infrastructure/store.js";
import { PostgresVectorIndexes } from "../../src/infrastructure/vector-indexes.js";
import { intelligenceApp } from "../../src/http/app.js";
import type { ModelUsageAdmission } from "../../src/application/preparation-jobs.js";
import type { Model, Sources } from "../../src/application/ports.js";
import type { Snapshot } from "../../src/domain/evidence.js";
const migration = databasePool(
  process.env.INTELLIGENCE_VECTOR_TEST_MIGRATION_URL ??
    "postgres://vs_intelligence_migration:local-migration-only@127.0.0.1:55443/intelligence",
  1,
);
const pool = databasePool(
  process.env.INTELLIGENCE_VECTOR_TEST_DATABASE_URL ??
    "postgres://vs_intelligence_runtime:local-runtime-only@127.0.0.1:55443/intelligence",
  3,
);
const repository = new PostgresIntelligence(pool),
  indexes = new PostgresVectorIndexes(pool);
before(async () => {
  await migrate(migration, fileURLToPath(new URL("../../migrations", import.meta.url)));
  await migrate(migration, fileURLToPath(new URL("../../specs", import.meta.url)));
  await assertRuntimeRole(pool);
});
after(async () => {
  await pool.end();
  await migration.end();
});
function fixture() {
  const actor: Actor = {
      workspaceId: randomUUID(),
      actorId: randomUUID(),
      sessionId: "owner-session",
    },
    meetingId = randomUUID(),
    captureId = randomUUID(),
    scope = { kind: "project" as const, id: randomUUID() };
  let allowed = true,
    embeddingCalls = 0,
    modelCalls = 0;
  let beforeChatReservation: () => Promise<void> = async () => {};
  let snapshot: Snapshot = {
    versions: [{ meetingId, version: 1, captureId, captureVersion: 3, coverage: "partial" }],
    evidence: Array.from({ length: 20 }, (_, index) => ({
      meetingId,
      captureId,
      segmentId: randomUUID(),
      revision: 3,
      startMs: index * 1000,
      endMs: index * 1000 + 1000,
      text:
        index === 0
          ? "PostgreSQL database migration. ".repeat(250)
          : "Customer renewal discussion.",
      speakerLabel: null,
    })),
  };
  const sources: Sources = {
    async requireActive() {
      if (!allowed) throw new AppError("FORBIDDEN", 403);
    },
    async read() {
      if (!allowed) throw new AppError("SOURCE_FORBIDDEN", 403);
      return structuredClone(snapshot);
    },
  };
  const purposes: string[] = [],
    outcomes: string[] = [],
    operations = new Map<string, string>();
  const admission: ModelUsageAdmission = {
    async reserve(_actor, input) {
      if (input.purpose === "chat") await beforeChatReservation();
      purposes.push(input.purpose);
      const old = operations.get(input.operationId);
      if (old) return { reservationId: old, replay: true, state: "held" };
      const reservationId = randomUUID();
      operations.set(input.operationId, reservationId);
      return { reservationId, replay: false, state: "held" };
    },
    async record(_actor, _id, outcome) {
      outcomes.push(outcome);
    },
  };
  const indexing = new EvidenceIndexing(
    sources,
    indexes,
    {
      async embed(texts) {
        embeddingCalls++;
        return texts.map((text) =>
          Array.from({ length: 1536 }, (_, index) =>
            index === (text.includes("database") ? 0 : 1) ? 1 : 0,
          ),
        );
      },
    },
    admission,
  );
  let handler: Model["generate"] = async ({ evidence }) => {
    assert.equal(
      evidence.filter((row) => row.segmentId === snapshot.evidence[0]!.segmentId).length,
      1,
    );
    const first = evidence[0]!;
    return {
      claims: [
        {
          kind: "discussion",
          text: first.text.slice(0, 100),
          citation: {
            meetingId: first.meetingId,
            captureId: first.captureId,
            segmentId: first.segmentId,
            revision: first.revision,
          },
        },
      ],
      unsupported: false,
    };
  };
  const model: Model = {
    async generate(input) {
      modelCalls++;
      return handler(input);
    },
  };
  const service = new IntelligenceService(
    repository,
    sources,
    model,
    admission,
    new IndexedChatEvidence(indexing),
  );
  return {
    actor,
    scope,
    meetingId,
    service,
    indexing,
    sources,
    model,
    admission,
    purposes,
    outcomes,
    get snapshot() {
      return snapshot;
    },
    set snapshot(value) {
      snapshot = value;
    },
    set allowed(value: boolean) {
      allowed = value;
    },
    set handler(value: Model["generate"]) {
      handler = value;
    },
    get embeddingCalls() {
      return embeddingCalls;
    },
    get modelCalls() {
      return modelCalls;
    },
    set beforeChatReservation(value: () => Promise<void>) {
      beforeChatReservation = value;
    },
  };
}
async function ready(f: ReturnType<typeof fixture>) {
  const job = await f.indexing.request(f.actor, randomUUID(), f.scope);
  while ((await f.indexing.status(f.actor, job.id)).status !== "complete")
    await f.indexing.work(f.actor.workspaceId, job.id);
  assert.deepEqual((await f.indexing.status(f.actor, job.id)).scope, f.scope);
  return job;
}
test("native indexed chat requires scoped ready index, persists explicit mode, and separates embedding/chat admissions", async () => {
  const f = fixture(),
    app = intelligenceApp(f.service, async () => f.actor, undefined, undefined, {
      indexing: f.indexing,
    });
  const thread = await f.service.createThread(f.actor, randomUUID(), {
    title: "Customer project",
    scope: f.scope,
  });
  const path = `/api/v3/workspaces/${f.actor.workspaceId}/intelligence/chats/${thread.id}/messages`;
  try {
    const missing = await app.inject({
      method: "POST",
      url: path,
      headers: { authorization: "Bearer owner", "idempotency-key": randomUUID() },
      payload: { text: "database", retrievalMode: "indexed" },
    });
    assert.equal(missing.statusCode, 409);
    assert.equal(missing.json().code, "INDEX_NOT_READY");
    assert.equal(f.embeddingCalls, 0);
    assert.equal(f.modelCalls, 0);
    await ready(f);
    const callsBefore = f.embeddingCalls;
    const key = randomUUID(),
      queued = await app.inject({
        method: "POST",
        url: path,
        headers: { authorization: "Bearer owner", "idempotency-key": key },
        payload: { text: "database", retrievalMode: "indexed" },
      });
    assert.equal(queued.statusCode, 202);
    const job = queued.json();
    assert.equal(job.retrievalMode, "indexed");
    assert.deepEqual(job.scope, f.scope);
    assert.equal(f.embeddingCalls, callsBefore, "preflight is non-billable");
    assert.equal(f.modelCalls, 0);
    const duplicate = await f.service.message(f.actor, thread.id, key, {
      text: "database",
      retrievalMode: "indexed",
    });
    assert.equal(duplicate.id, job.id);
    await assert.rejects(
      f.service.message(f.actor, thread.id, key, { text: "database" }),
      /IDEMPOTENCY_CONFLICT/,
    );
    await f.service.work(f.actor.workspaceId, job.id);
    const result = await f.service.job(f.actor, job.id);
    assert.equal(result.status, "complete");
    assert.equal(result.retrievalMode, "indexed");
    assert.equal(result.result!.claims[0]!.citation.revision, 3);
    assert.equal(result.result!.partial, true);
    assert.equal(f.modelCalls, 1);
    assert.equal(f.embeddingCalls, callsBefore + 1);
    assert.deepEqual(f.purposes.slice(-2), ["retrieval", "chat"]);
    assert(f.outcomes.every((outcome) => outcome === "succeeded"));
  } finally {
    await app.close();
  }
});
test("index mode stays opt-in and missing native adapter fails without lexical fallback or model call", async () => {
  const f = fixture(),
    disabled = new IntelligenceService(repository, f.sources, f.model);
  const thread = await disabled.createThread(f.actor, randomUUID(), {
    title: "Default saved chat",
    scope: f.scope,
  });
  await assert.rejects(
    disabled.message(f.actor, thread.id, randomUUID(), {
      text: "database",
      retrievalMode: "indexed",
    }),
    /RETRIEVAL_DISABLED/,
  );
  assert.equal(f.modelCalls, 0);
  assert.equal(f.embeddingCalls, 0);
  const lexical = await disabled.message(f.actor, thread.id, randomUUID(), { text: "database" });
  assert.equal(lexical.retrievalMode, "lexical");
  await disabled.work(f.actor.workspaceId, lexical.id);
  assert.equal((await disabled.job(f.actor, lexical.id)).status, "complete");
  assert.equal(f.modelCalls, 1);
  assert.equal(f.embeddingCalls, 0);
});
test("scope changes, corrections and revocation invalidate index readiness and queued answers", async () => {
  const f = fixture();
  await ready(f);
  const thread = await f.service.createThread(f.actor, randomUUID(), {
    title: "Selected project",
    scope: f.scope,
  });
  const queued = await f.service.message(f.actor, thread.id, randomUUID(), {
    text: "database",
    retrievalMode: "indexed",
  });
  const embedded = f.embeddingCalls;
  f.snapshot = {
    ...f.snapshot,
    evidence: f.snapshot.evidence.map((row) => ({
      ...row,
      revision: 4,
      text: "Owner correction.",
    })),
  };
  await assert.rejects(
    f.service.message(f.actor, thread.id, randomUUID(), {
      text: "database",
      retrievalMode: "indexed",
    }),
    /INDEX_NOT_READY/,
  );
  await f.service.work(f.actor.workspaceId, queued.id);
  assert.equal((await f.service.job(f.actor, queued.id)).errorCode, "INDEX_NOT_READY");
  assert.equal(f.embeddingCalls, embedded);
  assert.equal(f.modelCalls, 0);
  const other = await f.service.createThread(f.actor, randomUUID(), {
    title: "Other project",
    scope: { kind: "project", id: randomUUID() },
  });
  await assert.rejects(
    f.service.message(f.actor, other.id, randomUUID(), {
      text: "database",
      retrievalMode: "indexed",
    }),
    /INDEX_NOT_READY/,
  );
  f.allowed = false;
  await assert.rejects(f.service.messages(f.actor, thread.id), /FORBIDDEN/);
});
test("invalid multibyte query and source changes during generation block publication", async () => {
  const f = fixture();
  await ready(f);
  const thread = await f.service.createThread(f.actor, randomUUID(), {
    title: "Current project",
    scope: f.scope,
  });
  await assert.rejects(
    f.service.message(f.actor, thread.id, randomUUID(), {
      text: "😀".repeat(1600),
      retrievalMode: "indexed",
    }),
    /INVALID_QUERY/,
  );
  const queued = await f.service.message(f.actor, thread.id, randomUUID(), {
    text: "database",
    retrievalMode: "indexed",
  });
  f.handler = async () => {
    f.snapshot = {
      ...f.snapshot,
      versions: f.snapshot.versions.map((row) => ({ ...row, version: 2 })),
    };
    return { claims: [], unsupported: true };
  };
  await f.service.work(f.actor.workspaceId, queued.id);
  const result = await f.service.job(f.actor, queued.id);
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "SOURCE_CHANGED");
  assert.equal(result.result, null);
});
test("indexed lease covers retrieval phase and lost lease before chat dispatch records not-started", async () => {
  const f = fixture();
  await ready(f);
  const thread = await f.service.createThread(f.actor, randomUUID(), {
    title: "Lease guarded",
    scope: f.scope,
  });
  const indexed = await f.service.message(f.actor, thread.id, randomUUID(), {
    text: "database",
    retrievalMode: "indexed",
  });
  const claimed = await repository.scoped(f.actor.workspaceId, (tx) => tx.claim(indexed.id));
  assert(claimed);
  assert(claimed.leaseUntil!.getTime() - Date.now() > 590000);
  const lexical = await f.service.message(f.actor, thread.id, randomUUID(), { text: "database" });
  const ordinary = await repository.scoped(f.actor.workspaceId, (tx) => tx.claim(lexical.id));
  assert(ordinary);
  assert(ordinary.leaseUntil!.getTime() - Date.now() < 301000);
  const queued = await f.service.message(f.actor, thread.id, randomUUID(), {
    text: "database",
    retrievalMode: "indexed",
  });
  f.beforeChatReservation = async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id',$1,true)", [f.actor.workspaceId]);
      await client.query(
        "UPDATE intelligence_jobs SET lease_until=now()+interval '60 seconds' WHERE id=$1",
        [queued.id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };
  await f.service.work(f.actor.workspaceId, queued.id);
  assert.equal(f.modelCalls, 0);
  assert.equal((await f.service.job(f.actor, queued.id)).errorCode, "LEASE_LOST");
  assert.equal(f.outcomes.at(-1), "not_started");
});
