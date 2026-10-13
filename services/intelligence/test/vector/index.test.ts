import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  AppError,
  assertRuntimeRole,
  databasePool,
  migrate,
  type Actor,
} from "@visualsprint/platform";
import { EvidenceIndexing } from "../../src/application/indexing.js";
import { PostgresVectorIndexes } from "../../src/infrastructure/vector-indexes.js";
import { PostgresIntelligence } from "../../src/infrastructure/store.js";
import { fingerprint, type Snapshot } from "../../src/domain/evidence.js";
import { chunkEvidence } from "../../src/domain/indexing.js";
import type { Sources } from "../../src/application/ports.js";

// Explicit opt-in suite: never targets/migrates the existing PG55438 database.
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
const indexes = new PostgresVectorIndexes(pool),
  intelligence = new PostgresIntelligence(pool);
before(async () => {
  await migrate(migration, fileURLToPath(new URL("../../migrations", import.meta.url)));
  await migrate(migration, fileURLToPath(new URL("../../specs", import.meta.url)));
  await assertRuntimeRole(pool);
  assert.equal(
    (await pool.query("SELECT extversion FROM pg_extension WHERE extname='vector'")).rows[0]
      .extversion,
    "0.8.6",
  );
});
after(async () => {
  await pool.end();
  await migration.end();
});
const embedding = (first: number) =>
  Array.from({ length: 1536 }, (_, index) => (index === (first ? 0 : 1) ? 1 : 0));
function fixture() {
  const actor: Actor = {
      workspaceId: randomUUID(),
      actorId: randomUUID(),
      sessionId: "owner-session",
    },
    meetingId = randomUUID(),
    captureId = randomUUID();
  const scope = { kind: "project" as const, id: randomUUID() };
  let active = true,
    snapshot: Snapshot = {
      versions: [{ meetingId, version: 1, captureId, captureVersion: 4, coverage: "partial" }],
      evidence: Array.from({ length: 20 }, (_, index) => ({
        meetingId,
        captureId,
        segmentId: randomUUID(),
        revision: 2,
        startMs: index * 2000,
        endMs: index * 2000 + 1000,
        text: index === 0 ? "PostgreSQL database migration" : "Customer billing renewal",
        speakerLabel: null,
      })),
    };
  const sources: Sources = {
    async requireActive() {
      if (!active) throw new AppError("FORBIDDEN", 403);
    },
    async read() {
      if (!active) throw new AppError("FORBIDDEN", 403);
      return structuredClone(snapshot);
    },
  };
  const service = new EvidenceIndexing(
    sources,
    indexes,
    {
      async embed(texts) {
        return texts.map((text) => embedding(text.includes("database") ? 1 : 0));
      },
    },
    {
      async reserve() {
        return { reservationId: randomUUID(), replay: false, state: "held" as const };
      },
      async record() {},
    },
  );
  return {
    actor,
    meetingId,
    captureId,
    scope,
    service,
    get snapshot() {
      return snapshot;
    },
    set snapshot(value) {
      snapshot = value;
    },
    set active(value: boolean) {
      active = value;
    },
  };
}
test("real pgvector batches are durable, invisible until complete and rank cosine plus FTS", async () => {
  const f = fixture(),
    key = randomUUID();
  const job = await f.service.request(f.actor, key, f.scope);
  assert.equal((await f.service.request(f.actor, key, f.scope)).id, job.id);
  await assert.rejects(
    f.service.request(f.actor, key, { kind: "workspace", id: null }),
    /IDEMPOTENCY_CONFLICT/,
  );
  await f.service.work(f.actor.workspaceId, job.id);
  assert.equal(await indexes.latest(f.actor, f.scope, fingerprint(f.snapshot)), null);
  await assert.rejects(
    f.service.retrieve(f.actor, f.scope, "database", randomUUID()),
    /INDEX_NOT_READY/,
  );
  await f.service.work(f.actor.workspaceId, job.id);
  const current = await indexes.latest(f.actor, f.scope, fingerprint(f.snapshot));
  assert.equal(current!.cursor, 20);
  assert.equal(current!.attempts, 2);
  const result = await f.service.retrieve(f.actor, f.scope, "database migration", randomUUID());
  assert.equal(result.evidence[0]!.text, "PostgreSQL database migration");
  assert.equal(result.partial, true);
  assert.equal(result.evidence[0]!.revision, 2);
});
test("tenant and owner filters apply before vector ranking, not after leaked candidates", async () => {
  const f = fixture();
  const job = await f.service.request(f.actor, randomUUID(), f.scope);
  await f.service.work(f.actor.workspaceId, job.id);
  await f.service.work(f.actor.workspaceId, job.id);
  assert.equal((await pool.query("SELECT * FROM evidence_embeddings")).rows.length, 0);
  await assert.rejects(
    indexes.search(
      { ...f.actor, actorId: randomUUID() },
      job.id,
      [f.meetingId],
      embedding(1),
      "database",
    ),
    /INDEX_NOT_READY/,
  );
  await assert.rejects(
    indexes.search(
      { ...f.actor, workspaceId: randomUUID() },
      job.id,
      [f.meetingId],
      embedding(1),
      "database",
    ),
    /INDEX_NOT_READY/,
  );
  assert.equal(
    (await indexes.search(f.actor, job.id, [randomUUID()], embedding(1), "database")).length,
    0,
  );
});
test("source corrections and logout fail closed before another billable embedding batch", async () => {
  const f = fixture();
  const job = await f.service.request(f.actor, randomUUID(), f.scope);
  await f.service.work(f.actor.workspaceId, job.id);
  f.snapshot = {
    ...f.snapshot,
    evidence: f.snapshot.evidence.map((row) => ({ ...row, revision: 3, text: "Corrected source" })),
  };
  await f.service.work(f.actor.workspaceId, job.id);
  assert.equal(await indexes.latest(f.actor, f.scope, fingerprint(f.snapshot)), null);
  const next = fixture();
  const queued = await next.service.request(next.actor, randomUUID(), next.scope);
  next.active = false;
  await next.service.work(next.actor.workspaceId, queued.id);
  assert.equal(await indexes.latest(next.actor, next.scope, fingerprint(next.snapshot)), null);
});
test("stale workers cannot stage vectors and deletion tombstones prevent reindex resurrection", async () => {
  const f = fixture();
  const job = await f.service.request(f.actor, randomUUID(), f.scope);
  const claim = await indexes.claim(f.actor.workspaceId, job.id);
  assert(claim);
  assert.equal(await indexes.claim(f.actor.workspaceId, job.id), null);
  const chunks = chunkEvidence(f.snapshot.evidence)
    .slice(0, 16)
    .map((row) => ({ ...row, embedding: embedding(1) }));
  assert.equal(await indexes.stage({ ...claim, leaseToken: randomUUID() }, chunks, false), false);
  await assert.rejects(
    indexes.purgeMeeting(f.actor.workspaceId, f.meetingId),
    /DELETION_BARRIER_REQUIRED/,
  );
  await intelligence.scoped(f.actor.workspaceId, (tx) =>
    tx.purgeMeeting(f.meetingId, randomUUID(), 1),
  );
  await indexes.purgeMeeting(f.actor.workspaceId, f.meetingId);
  await assert.rejects(indexes.stage(claim, chunks, false), /SOURCE_DELETED/);
  await assert.rejects(f.service.request(f.actor, randomUUID(), f.scope), /SOURCE_DELETED/);
});
