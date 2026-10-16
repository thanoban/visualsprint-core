import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { exportJWK, generateKeyPair } from "jose";
import {
  AppError,
  databasePool,
  migrate,
  assertRuntimeRole,
  installErrorHandler,
  ServiceIdentity,
  serviceToken,
  type Actor,
} from "@visualsprint/platform";
import { WorkspaceService } from "../../src/application/workspace.js";
import { PostgresWorkspace } from "../../src/infrastructure/store.js";
import { AgendasService, type AgendaDTO } from "../../src/application/agendas.js";
import { PostgresAgendas } from "../../src/infrastructure/agenda-store.js";
import { WorkspaceExportContext } from "../../src/application/export-context.js";
import { CommitmentsService, acceptedFingerprint } from "../../src/application/commitments.js";
import { PostgresCommitments } from "../../src/infrastructure/commitment-store.js";
import { PostgresDeletions } from "../../src/infrastructure/deletion-store.js";
import { agendaRoutes, exportContextRoutes } from "../../src/http/agenda-routes.js";
const migration = databasePool(
  process.env.WORKSPACE_TEST_MIGRATION_URL ??
    "postgres://vs_workspace_migration:local-migration-only@127.0.0.1:55433/workspace",
  1,
);
const pool = databasePool(
  process.env.WORKSPACE_TEST_DATABASE_URL ??
    "postgres://vs_workspace_runtime:local-runtime-only@127.0.0.1:55433/workspace",
  4,
);
before(async () => {
  await migrate(migration, fileURLToPath(new URL("../../migrations", import.meta.url)));
  await assertRuntimeRole(pool);
});
after(async () => {
  await pool.end();
  await migration.end();
});
async function scoped<T>(ws: string, work: (db: import("pg").PoolClient) => Promise<T>) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT set_config('app.workspace_id',$1,true)", [ws]);
    const result = await work(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
async function fixture() {
  const actor: Actor = { workspaceId: randomUUID(), actorId: randomUUID(), sessionId: "agenda-pg" },
    reader = { ...actor, actorId: randomUUID() };
  let active = true,
    sourceCurrent = true;
  const workspace = new WorkspaceService(
    new PostgresWorkspace(pool),
    {
      async requireActive(a) {
        if (!active || a.workspaceId !== actor.workspaceId) throw new AppError("FORBIDDEN", 403);
      },
      async requireMember() {
        return;
      },
    },
    {
      async check() {
        return true;
      },
      async checkMany(_a, checks) {
        return checks.map(() => true);
      },
    },
  );
  const meeting = await workspace.addMeeting(actor, randomUUID(), {
      title: "Agenda qualification",
    }),
    store = new PostgresAgendas(pool),
    service = new AgendasService(store, workspace);
  const records = new CommitmentsService(
    new PostgresCommitments(pool),
    {
      meeting: (a, id) => workspace.meeting(a, id),
      readable: async (a, scope) =>
        (await workspace.intelligenceContext(a, { scope })).meetings.map((m) => m.id),
      async member() {
        return;
      },
    },
    {
      async validate(_a, id, refs) {
        if (!sourceCurrent) throw new AppError("SOURCE_EVIDENCE_CHANGED", 409);
        return {
          meetingId: id,
          citations: refs.map((ref) => ({
            ...ref,
            captureVersion: 1,
            coverage: "partial" as const,
          })),
          fingerprint: acceptedFingerprint(refs),
          partial: true,
        };
      },
      async proposal() {
        throw new AppError("NOT_FOUND", 404);
      },
    },
  );
  const exports = new WorkspaceExportContext(workspace, store, records);
  return {
    actor,
    reader,
    workspace,
    meeting,
    store,
    service,
    records,
    exports,
    set active(value: boolean) {
      active = value;
    },
    set sourceCurrent(value: boolean) {
      sourceCurrent = value;
    },
  };
}
const content = {
  title: "Next customer review",
  body: "Review the owner-approved offer and delivery risks.",
  expectedMeetingVersion: 1,
  confirmed: true as const,
};
test("reviewed agenda commands serialize duplicate creation, enforce optimistic versions and never grant sharing", async () => {
  const f = await fixture(),
    key = randomUUID();
  const [a, b] = await Promise.all([
    f.service.mutate(f.actor, f.meeting.id, key, "create", content),
    f.service.mutate(f.actor, f.meeting.id, key, "create", content),
  ]);
  assert.equal(a.id, b.id);
  assert.equal((await f.workspace.meeting(f.actor, f.meeting.id)).version, 2);
  assert.equal((await f.service.list(f.actor, f.meeting.id)).length, 1);
  await assert.rejects(f.service.list(f.reader, f.meeting.id));
  await assert.rejects(
    f.service.mutate(f.actor, f.meeting.id, key, "create", { ...content, title: "Changed" }),
    /IDEMPOTENCY_CONFLICT/,
  );
  const updated = (await f.service.mutate(
    f.actor,
    f.meeting.id,
    randomUUID(),
    "update",
    {
      ...content,
      expectedMeetingVersion: 2,
      expectedVersion: 1,
      body: "Owner-corrected next steps",
    },
    a.id,
  )) as AgendaDTO;
  assert.equal(updated.version, 2);
  await assert.rejects(
    f.service.mutate(
      f.actor,
      f.meeting.id,
      randomUUID(),
      "update",
      { ...content, expectedMeetingVersion: 2, expectedVersion: 2 },
      a.id,
    ),
    /SOURCE_MEETING_CHANGED/,
  );
  await assert.rejects(
    f.service.mutate(
      f.actor,
      f.meeting.id,
      randomUUID(),
      "update",
      { ...content, expectedMeetingVersion: 3, expectedVersion: 1 },
      a.id,
    ),
    /VERSION_CONFLICT/,
  );
  const shared = await f.workspace.share(f.actor, f.meeting.id, randomUUID(), {
    userId: f.reader.actorId,
    expectedVersion: 3,
  });
  assert.equal((await f.service.list(f.reader, f.meeting.id))[0]!.id, a.id);
  await assert.rejects(
    f.service.mutate(
      f.reader,
      f.meeting.id,
      randomUUID(),
      "update",
      { ...content, expectedMeetingVersion: shared.version, expectedVersion: 2 },
      a.id,
    ),
    /FORBIDDEN/,
  );
  const rows = await pool.query("SELECT * FROM reviewed_agendas WHERE id=$1", [a.id]);
  assert.equal(rows.rowCount, 0);
  await scoped(randomUUID(), async (db) =>
    assert.equal(
      (await db.query("SELECT * FROM reviewed_agendas WHERE id=$1", [a.id])).rowCount,
      0,
    ),
  );
});
test("delete replay is metadata-only, rejects stale edits and cannot resurrect agenda", async () => {
  const f = await fixture(),
    agenda = await f.service.mutate(f.actor, f.meeting.id, randomUUID(), "create", content);
  const key = randomUUID(),
    body = { confirmed: true, expectedMeetingVersion: 2, expectedVersion: 1 };
  const deleted = await f.service.mutate(f.actor, f.meeting.id, key, "delete", body, agenda.id);
  assert.deepEqual(
    await f.service.mutate(f.actor, f.meeting.id, key, "delete", body, agenda.id),
    deleted,
  );
  assert.equal((await f.service.list(f.actor, f.meeting.id)).length, 0);
  assert.ok(!JSON.stringify(deleted).includes(content.body));
  await assert.rejects(
    f.service.mutate(
      f.actor,
      f.meeting.id,
      randomUUID(),
      "update",
      { ...content, expectedMeetingVersion: 3, expectedVersion: 1 },
      agenda.id,
    ),
    /NOT_FOUND/,
  );
});
test("export includes reviewed agenda and accepted citations with current or changed evidence truth", async () => {
  const f = await fixture();
  await f.service.mutate(f.actor, f.meeting.id, randomUUID(), "create", content);
  const item = await f.records.accept(f.actor, randomUUID(), "commitment", {
    meetingId: f.meeting.id,
    expectedMeetingVersion: 2,
    confirmed: true,
    content: {
      title: "Reviewed promise",
      text: "Send revised offer",
      ownerId: null,
      dueDate: null,
      citations: [{ captureId: randomUUID(), segmentId: randomUUID(), revision: 1 }],
    },
  });
  const result = await f.exports.read(f.actor, f.meeting.id);
  assert.equal(result.complete, true);
  assert.equal(result.meetingVersion, 2);
  assert.equal(result.agendas[0]!.reviewed, true);
  assert.equal(result.commitments[0]!.id, item.id);
  assert.equal(result.commitments[0]!.humanReviewed, true);
  assert.equal(result.commitments[0]!.sourcePartial, true);
  assert.equal(result.commitments[0]!.evidenceStatus, "current");
  assert.deepEqual(
    Object.keys(result.commitments[0]!).sort(),
    [
      "id",
      "meetingId",
      "kind",
      "title",
      "text",
      "ownerId",
      "dueDate",
      "state",
      "version",
      "sourceMeetingVersion",
      "citations",
      "sourcePartial",
      "humanReviewed",
      "humanCorrected",
      "evidenceStatus",
      "statusSource",
      "createdAt",
      "updatedAt",
    ].sort(),
  );
  f.sourceCurrent = false;
  assert.equal(
    (await f.exports.read(f.actor, f.meeting.id)).commitments[0]!.evidenceStatus,
    "changed",
  );
  f.active = false;
  await assert.rejects(f.exports.read(f.actor, f.meeting.id), /FORBIDDEN/);
});
test("export refuses concurrent accepted edits that do not bump meeting version and oversized scopes", async () => {
  const f = await fixture(),
    refs = [{ captureId: randomUUID(), segmentId: randomUUID(), revision: 1 }];
  const item = await f.records.accept(f.actor, randomUUID(), "decision", {
    meetingId: f.meeting.id,
    expectedMeetingVersion: 1,
    confirmed: true,
    content: {
      title: "Reviewed decision",
      text: "Keep the current offer",
      ownerId: null,
      dueDate: null,
      citations: refs,
    },
  });
  let changed = false;
  const racing = new WorkspaceExportContext(f.workspace, f.store, {
    async list(a, kind, scope, complete) {
      const rows = await f.records.list(a, kind, scope, complete);
      if (kind === "decision" && !changed) {
        changed = true;
        await f.records.correct(f.actor, item.id, "decision", randomUUID(), {
          expectedVersion: 1,
          expectedMeetingVersion: 1,
          confirmed: true,
          content: {
            title: "Updated review",
            text: "Use the revised offer",
            ownerId: null,
            dueDate: null,
            citations: refs,
          },
        });
      }
      return rows;
    },
  });
  await assert.rejects(racing.read(f.actor, f.meeting.id), /EXPORT_CONTEXT_CHANGED/);
  await scoped(f.actor.workspaceId, async (db) => {
    await db.query(
      `INSERT INTO accepted_items(workspace_id,id,meeting_id,created_by,reviewed_by,kind,title,body,state,source_meeting_version,citations,source_fingerprint,source_partial)
 SELECT $1,gen_random_uuid(),$2,$3,$3,'decision','Bulk reviewed','Reviewed','accepted',1,'[]'::jsonb,'fixture',false FROM generate_series(1,100)`,
      [f.actor.workspaceId, f.meeting.id, f.actor.actorId],
    );
  });
  await assert.rejects(f.exports.read(f.actor, f.meeting.id), /REVIEW_SCOPE_TOO_LARGE/);
  assert.deepEqual(await f.service.list(f.actor, f.meeting.id), []);
});
test("meeting deletion purges agenda text and command references; old commands cannot resurrect content", async () => {
  const f = await fixture(),
    key = randomUUID();
  await f.service.mutate(f.actor, f.meeting.id, key, "create", content);
  await new PostgresDeletions(pool).request(
    f.actor,
    randomUUID(),
    { meetingId: f.meeting.id, expectedVersion: 2 },
    ["ingest"],
  );
  await scoped(f.actor.workspaceId, async (db) => {
    assert.equal(
      (await db.query("SELECT * FROM reviewed_agendas WHERE meeting_id=$1", [f.meeting.id]))
        .rowCount,
      0,
    );
    assert.equal(
      (await db.query("SELECT * FROM agenda_commands WHERE meeting_id=$1", [f.meeting.id]))
        .rowCount,
      0,
    );
  });
  await assert.rejects(f.service.mutate(f.actor, f.meeting.id, key, "create", content));
  await assert.rejects(f.exports.read(f.actor, f.meeting.id));
});
test("native HTTP uses pinned Reporting-only signer and normal scoped actors; owner mutation requires confirmation/key", async () => {
  const f = await fixture(),
    keys = await generateKeyPair("EdDSA"),
    jwk = { ...(await exportJWK(keys.publicKey)), kid: "reporting-agenda-fixture" },
    identity = new ServiceIdentity("workspace", { reporting: [jwk] }),
    app = Fastify();
  installErrorHandler(app);
  agendaRoutes(app, f.service, async (token) => {
    if (token === "owner") return f.actor;
    if (token === "reader") return f.reader;
    throw new AppError("FORBIDDEN", 403);
  });
  exportContextRoutes(app, f.exports, async (token) => {
    const hop = await identity.verify(token);
    if (hop.caller !== "reporting") throw new AppError("FORBIDDEN", 403);
    return hop.actor;
  });
  const root = `/api/v3/workspaces/${f.actor.workspaceId}/meetings/${f.meeting.id}/agendas`,
    internal = `/internal/workspaces/${f.actor.workspaceId}/meetings/${f.meeting.id}/export-context`;
  try {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: root,
          headers: { authorization: "Bearer owner" },
          payload: content,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: root,
          headers: { authorization: "Bearer owner", "idempotency-key": randomUUID() },
          payload: { ...content, confirmed: false },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: root,
          headers: { authorization: "Bearer owner", "idempotency-key": randomUUID() },
          payload: content,
        })
      ).statusCode,
      201,
    );
    const sign = (caller: string, actor: Actor = f.actor) =>
      serviceToken({
        caller,
        audience: "workspace",
        actor,
        privateKey: keys.privateKey,
        keyId: "reporting-agenda-fixture",
      });
    const success = await app.inject({
      url: internal,
      headers: { authorization: `Bearer ${await sign("reporting")}` },
    });
    assert.equal(success.statusCode, 200);
    assert.equal(success.headers["cache-control"], "no-store");
    assert.equal(success.json().complete, true);
    const operationGrantId = randomUUID();
    for (const [caller, actor] of [
      ["intelligence", f.actor],
      ["reporting", { ...f.actor, operationGrantId, sessionId: `operation:${operationGrantId}` }],
      ["reporting", { ...f.actor, workspaceId: randomUUID() }],
    ] as [string, Actor][]) {
      assert.notEqual(
        (
          await app.inject({
            url: internal,
            headers: { authorization: `Bearer ${await sign(caller, actor)}` },
          })
        ).statusCode,
        200,
      );
    }
  } finally {
    await app.close();
  }
});
