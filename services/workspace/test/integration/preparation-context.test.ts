import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { generateKeyPair, exportJWK } from "jose";
import Fastify from "fastify";
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
import { CommitmentsService, acceptedFingerprint } from "../../src/application/commitments.js";
import { PostgresCommitments } from "../../src/infrastructure/commitment-store.js";
import { WorkspacePreparationContext } from "../../src/application/preparation-context.js";
import { preparationContextRoutes } from "../../src/http/preparation-context-routes.js";
import { PostgresDeletions } from "../../src/infrastructure/deletion-store.js";

const migration = databasePool(
  process.env.WORKSPACE_TEST_MIGRATION_URL ??
    "postgres://vs_workspace_migration:local-migration-only@127.0.0.1:55433/workspace",
  1,
);
const pool = databasePool(
  process.env.WORKSPACE_TEST_DATABASE_URL ??
    "postgres://vs_workspace_runtime:local-runtime-only@127.0.0.1:55433/workspace",
  3,
);
before(async () => {
  await migrate(migration, fileURLToPath(new URL("../../migrations", import.meta.url)));
  await assertRuntimeRole(pool);
});
after(async () => {
  await pool.end();
  await migration.end();
});
async function fixture() {
  const actor: Actor = {
    workspaceId: randomUUID(),
    actorId: randomUUID(),
    sessionId: "preparation-fixture",
  };
  const reader = { ...actor, actorId: randomUUID() };
  let active = true,
    sourceCurrent = true;
  const membership = {
    async requireActive(a: Actor) {
      if (!active || a.workspaceId !== actor.workspaceId) throw new AppError("FORBIDDEN", 403);
    },
    async requireMember(ws: string, _id: string, a: Actor) {
      if (ws !== a.workspaceId) throw new AppError("FORBIDDEN", 403);
    },
  };
  const workspace = new WorkspaceService(new PostgresWorkspace(pool), membership, {
    async check() {
      return true;
    },
    async checkMany(_a, checks) {
      return checks.map(() => true);
    },
  });
  const customer = await workspace.addCustomer(actor, randomUUID(), { name: "Confirmed customer" });
  const project = await workspace.addProject(actor, randomUUID(), {
    name: "Confirmed history",
    customerId: customer.id,
  });
  let history = await workspace.addMeeting(actor, randomUUID(), {
    title: "Authorized prior meeting",
  });
  history = await workspace.assign(actor, history.id, randomUUID(), {
    projectId: project.id,
    confirmed: true,
    expectedVersion: history.version,
  });
  let target = await workspace.addMeeting(actor, randomUUID(), { title: "Next meeting" });
  target = await workspace.assign(actor, target.id, randomUUID(), {
    projectId: project.id,
    confirmed: true,
    expectedVersion: target.version,
  });
  const separate = await workspace.addMeeting(actor, randomUUID(), {
    title: "Unassigned confidential meeting",
  });
  const citation = { captureId: randomUUID(), segmentId: randomUUID(), revision: 1 };
  const records = new CommitmentsService(
    new PostgresCommitments(pool),
    {
      meeting: (a, id) => workspace.meeting(a, id),
      readable: async (a, scope) =>
        (await workspace.intelligenceContext(a, { scope })).meetings.map((m) => m.id),
      member: (a, id) => membership.requireMember(a.workspaceId, id, a),
    },
    {
      async validate(_a, id, refs) {
        if (!sourceCurrent) throw new AppError("SOURCE_EVIDENCE_CHANGED", 409);
        return {
          meetingId: id,
          citations: refs.map((r) => ({ ...r, captureVersion: 1, coverage: "partial" as const })),
          fingerprint: acceptedFingerprint(refs),
          partial: true,
        };
      },
      async proposal() {
        throw new AppError("NOT_FOUND", 404);
      },
    },
  );
  const accepted = await records.accept(actor, randomUUID(), "commitment", {
    meetingId: history.id,
    expectedMeetingVersion: history.version,
    confirmed: true,
    proposal: null,
    content: {
      title: "Human reviewed follow-up",
      text: "Send the revised offer",
      ownerId: null,
      dueDate: null,
      citations: [citation],
    },
  });
  await records.status(actor, accepted.id, "commitment", randomUUID(), {
    expectedVersion: accepted.version,
    confirmed: true,
    state: "completed",
  });
  await records.accept(actor, randomUUID(), "decision", {
    meetingId: history.id,
    expectedMeetingVersion: history.version,
    confirmed: true,
    proposal: null,
    content: {
      title: "Reviewed decision",
      text: "Use the agreed onboarding approach",
      ownerId: null,
      dueDate: null,
      citations: [citation],
    },
  });
  await records.accept(actor, randomUUID(), "commitment", {
    meetingId: target.id,
    expectedMeetingVersion: target.version,
    confirmed: true,
    proposal: null,
    content: {
      title: "Target is not prior history",
      text: "Do not include the target's facts",
      ownerId: null,
      dueDate: null,
      citations: [citation],
    },
  });
  const context = new WorkspacePreparationContext(workspace, records);
  const input = {
    meetingId: target.id,
    historyScope: { kind: "project" as const, id: project.id },
    confirmedScope: true,
  };
  return {
    actor,
    reader,
    target,
    history,
    separate,
    project,
    customer,
    workspace,
    records,
    context,
    input,
    revoke: () => {
      active = false;
    },
    changeEvidence: () => {
      sourceCurrent = false;
    },
  };
}

test("preparation uses confirmed readable context and preserves human status without pretending external verification", async () => {
  const f = await fixture(),
    result = await f.context.read(f.actor, f.input);
  assert.deepEqual(
    result.history.meetings.map((m) => m.id),
    [f.history.id],
  );
  assert.equal(result.target.id, f.target.id);
  assert.equal(result.commitments.length, 1);
  assert.equal(result.decisions.length, 1);
  assert.equal(result.commitments[0]!.state, "completed");
  assert.equal(result.commitments[0]!.statusSource, "human_review");
  assert.equal(result.commitments[0]!.externalStatus, "unknown");
  assert.equal(result.commitments[0]!.externalVerifiedAt, null);
  assert.equal(result.commitments[0]!.sourcePartial, true);
  assert.equal(JSON.stringify(result).includes(f.separate.id), false);
  assert.equal(JSON.stringify(result).includes("notes"), false);
  assert.deepEqual(
    (
      await f.context.read(f.actor, {
        ...f.input,
        historyScope: { kind: "customer", id: f.customer.id },
      })
    ).history.meetings.map((m) => m.id),
    [f.history.id],
  );
  f.changeEvidence();
  assert.equal((await f.context.read(f.actor, f.input)).commitments[0]!.evidenceStatus, "changed");
});

test("preparation rejects unconfirmed scope, shared-reader targets, operation principals and revoked/deleted context", async () => {
  const f = await fixture();
  await assert.rejects(f.context.read(f.actor, { ...f.input, confirmedScope: false }));
  await assert.rejects(
    f.context.read(f.actor, { ...f.input, historyScope: { kind: "meeting", id: f.target.id } }),
    /TARGET_IS_NOT_HISTORY/,
  );
  await assert.rejects(
    f.context.read({ ...f.actor, operationGrantId: randomUUID() }, f.input),
    /FORBIDDEN/,
  );
  const shared = await f.workspace.share(f.actor, f.target.id, randomUUID(), {
    userId: f.reader.actorId,
    expectedVersion: f.target.version,
  });
  assert.equal((await f.workspace.meeting(f.reader, shared.id)).id, shared.id);
  await assert.rejects(f.context.read(f.reader, f.input), /NOT_FOUND|FORBIDDEN/);
  await assert.rejects(
    f.context.read({ ...f.actor, workspaceId: randomUUID() }, f.input),
    /FORBIDDEN/,
  );
  f.revoke();
  await assert.rejects(f.context.read(f.actor, f.input), /FORBIDDEN/);
});

test("preparation rejects history changes while composing and never publishes mismatched records", async () => {
  const f = await fixture();
  let calls = 0;
  const context = new WorkspacePreparationContext(
    {
      meeting: (a, id) => f.workspace.meeting(a, id),
      manageContext: (a, id) => f.workspace.manageContext(a, id),
      intelligenceContext: async (a, input) => {
        const value = await f.workspace.intelligenceContext(a, input);
        if (++calls === 2) return { meetings: value.meetings.filter((m) => m.id !== f.history.id) };
        return value;
      },
    },
    f.records,
  );
  await assert.rejects(context.read(f.actor, f.input), /PREPARATION_CONTEXT_CHANGED/);
});

test("internal preparation context pins Intelligence signer, actor and workspace; gateway signatures cannot read it", async () => {
  const f = await fixture(),
    keys = await generateKeyPair("EdDSA"),
    wrong = await generateKeyPair("EdDSA"),
    kid = "intel-preparation-fixture";
  const identity = new ServiceIdentity("workspace", {
    intelligence: [{ ...(await exportJWK(keys.publicKey)), kid }],
  });
  const app = Fastify({ logger: false });
  installErrorHandler(app);
  preparationContextRoutes(app, f.context, async (token) => (await identity.verify(token)).actor);
  const token = await serviceToken({
    caller: "intelligence",
    audience: "workspace",
    actor: f.actor,
    privateKey: keys.privateKey,
    keyId: kid,
  });
  const invalid = await serviceToken({
    caller: "gateway",
    audience: "workspace",
    actor: f.actor,
    privateKey: wrong.privateKey,
    keyId: kid,
  });
  const path = `/internal/workspaces/${f.actor.workspaceId}/preparation-context`;
  try {
    assert.equal(
      (await app.inject({ method: "POST", url: path, payload: f.input })).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: path,
          headers: { authorization: `Bearer ${invalid}` },
          payload: f.input,
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/internal/workspaces/${randomUUID()}/preparation-context`,
          headers: { authorization: `Bearer ${token}` },
          payload: f.input,
        })
      ).statusCode,
      403,
    );
    const response = await app.inject({
      method: "POST",
      url: path,
      headers: { authorization: `Bearer ${token}` },
      payload: f.input,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.json().target.id, f.target.id);
  } finally {
    await app.close();
  }
});

test("deleted target cannot serve preparation context or recreate its reviewed source", async () => {
  const f = await fixture();
  await new PostgresDeletions(pool).request(
    f.actor,
    randomUUID(),
    { meetingId: f.target.id, expectedVersion: f.target.version },
    ["intelligence"],
  );
  await assert.rejects(f.context.read(f.actor, f.input), /NOT_FOUND/);
});

test("preparation refuses a silently truncated accepted-record scope", async () => {
  const f = await fixture(),
    client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id',$1,true)", [f.actor.workspaceId]);
    await client.query(
      "INSERT INTO accepted_items(workspace_id,id,meeting_id,created_by,reviewed_by,kind,title,body,state,source_meeting_version,citations,source_fingerprint,source_partial) SELECT $1,gen_random_uuid(),$2,$3,$3,'commitment','Bounded fixture','Reviewed fixture','open',$4,'[]'::jsonb,'fixture',false FROM generate_series(1,101)",
      [f.actor.workspaceId, f.history.id, f.actor.actorId, f.history.version],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  await assert.rejects(f.context.read(f.actor, f.input), /REVIEW_SCOPE_TOO_LARGE/);
});
