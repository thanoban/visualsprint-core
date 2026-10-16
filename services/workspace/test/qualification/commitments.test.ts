// Explicit isolated local qualification; no production or main Workspace data is modified.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import Fastify from "fastify";
import {
  databasePool,
  migrate,
  assertRuntimeRole,
  AppError,
  installErrorHandler,
  type Actor,
} from "@visualsprint/platform";
import {
  CommitmentsService,
  acceptedFingerprint,
  type CommitmentAuthority,
  type CommitmentEvidence,
  type EvidenceProof,
  type ProposalProof,
} from "../../src/application/commitments.js";
import { PostgresCommitments } from "../../src/infrastructure/commitment-store.js";
import { PostgresDeletions } from "../../src/infrastructure/deletion-store.js";
import { commitmentRoutes } from "../../src/http/commitment-routes.js";
const migration = databasePool(
    "postgres://vs_commitment_test_migration:local-migration-only@127.0.0.1:55433/workspace_commitment_test",
    1,
  ),
  pool = databasePool(
    "postgres://vs_commitment_test_runtime:local-runtime-only@127.0.0.1:55433/workspace_commitment_test",
    3,
  ),
  store = new PostgresCommitments(pool);
before(async () => {
  assert.equal(
    (await migration.query("SELECT current_database() AS name")).rows[0]?.name,
    "workspace_commitment_test",
  );
  await migrate(migration, fileURLToPath(new URL("../../migrations", import.meta.url)));
  await migration.query("GRANT USAGE ON SCHEMA public TO vs_commitment_test_runtime");
  await migration.query(
    "REVOKE ALL ON schema_migrations FROM vs_commitment_test_runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON meetings,meeting_readers,meeting_assignments,outbox,event_work_index,accepted_items,reviewed_agendas,agenda_commands,calendar_meetings,commands,deletion_jobs,deletion_commands,deletion_work_index TO vs_commitment_test_runtime; GRANT SELECT,INSERT ON accepted_commands TO vs_commitment_test_runtime",
  );
  await assertRuntimeRole(pool);
});
after(async () => {
  await pool.end();
  await migration.end();
});
async function scoped<T>(ws: string, work: (c: PoolClient) => Promise<T>) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.workspace_id',$1,true)", [ws]);
    const result = await work(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
async function fixture() {
  const actor: Actor = { workspaceId: randomUUID(), actorId: randomUUID(), sessionId: "fixture" },
    meetingId = randomUUID(),
    assignee = randomUUID(),
    citation = { captureId: randomUUID(), segmentId: randomUUID(), revision: 1 };
  let active = true,
    shared = false,
    revision = 1,
    evidenceChanged = false,
    memberValid = true;
  const proof: EvidenceProof = {
    meetingId,
    citations: [{ ...citation, captureVersion: 4, coverage: "partial" }],
    fingerprint: acceptedFingerprint("snapshot"),
    partial: true,
  };
  const proposal: ProposalProof = {
    jobId: randomUUID(),
    claimIndex: 0,
    kind: "commitment",
    text: "Original model excerpt",
    citation: { meetingId, ...citation },
  };
  await scoped(actor.workspaceId, (c) =>
    c.query(
      "INSERT INTO meetings(workspace_id,id,owner_id,title,notes) VALUES($1,$2,$3,'Customer call','Private note')",
      [actor.workspaceId, meetingId, actor.actorId],
    ),
  );
  const authority: CommitmentAuthority = {
    async meeting(principal, id) {
      if (
        !active ||
        id !== meetingId ||
        principal.workspaceId !== actor.workspaceId ||
        (principal.actorId !== actor.actorId && !shared)
      )
        throw new AppError("NOT_FOUND", 404);
      const row = await scoped(
        actor.workspaceId,
        async (c) =>
          (await c.query("SELECT owner_id,version,blocked FROM meetings WHERE id=$1", [meetingId]))
            .rows[0],
      );
      if (row?.blocked) throw new AppError("NOT_FOUND", 404);
      return { id: meetingId, ownerId: actor.actorId, version: Number(row.version) };
    },
    async readable(principal) {
      await this.meeting(principal, meetingId);
      return [meetingId];
    },
    async member(_actor, id) {
      if (!memberValid || id !== assignee) throw new AppError("FORBIDDEN", 403);
    },
  };
  const evidence: CommitmentEvidence = {
    async validate(_actor, id, refs) {
      if (
        id !== meetingId ||
        refs.some(
          (r) =>
            r.captureId !== citation.captureId ||
            r.segmentId !== citation.segmentId ||
            r.revision !== revision,
        ) ||
        evidenceChanged
      )
        throw new AppError("SOURCE_EVIDENCE_CHANGED", 409);
      return proof;
    },
    async proposal(_actor, id, index) {
      if (id !== proposal.jobId || index !== 0) throw new AppError("PROPOSAL_NOT_AVAILABLE", 409);
      return proposal;
    },
  };
  const service = new CommitmentsService(store, authority, evidence);
  const body = () => ({
    meetingId,
    expectedMeetingVersion: 1,
    confirmed: true,
    content: {
      title: "Reviewed commitment",
      text: "Human reviewed and corrected statement",
      ownerId: null,
      dueDate: null,
      citations: [citation],
    },
    proposal: { jobId: proposal.jobId, claimIndex: 0 },
  });
  return {
    actor,
    meetingId,
    assignee,
    service,
    body,
    proof,
    proposal,
    sourceChanged: () => {
      evidenceChanged = true;
    },
    revoke: () => {
      active = false;
    },
    share: () => {
      shared = true;
    },
    badMember: () => {
      memberValid = false;
    },
    advanceRevision: () => {
      revision++;
    },
    editMeeting: () =>
      scoped(actor.workspaceId, (c) =>
        c.query("UPDATE meetings SET version=version+1 WHERE id=$1", [meetingId]),
      ),
  };
}
test("owner-reviewed facts persist with exact citations, null unknowns and metadata-only events; late replay preserves corrections", async () => {
  const f = await fixture(),
    body = f.body(),
    item = await f.service.accept(f.actor, "accept-command-1", "commitment", body);
  assert.equal(item.ownerId, null);
  assert.equal(item.dueDate, null);
  assert.equal(item.humanCorrected, true);
  assert.equal(item.sourcePartial, true);
  assert.equal(item.proposalRef?.jobId, f.proposal.jobId);
  await assert.rejects(
    f.service.accept(f.actor, "accept-command-1", "commitment", {
      ...body,
      content: { ...body.content, text: "Changed input" },
    }),
    (e) => e instanceof AppError && e.code === "IDEMPOTENCY_CONFLICT",
  );
  const corrected = await f.service.correct(f.actor, item.id, "commitment", "correct-command-1", {
    expectedVersion: 1,
    expectedMeetingVersion: 1,
    confirmed: true,
    content: {
      ...body.content,
      text: "Preserved human correction",
      ownerId: f.assignee,
      dueDate: "2026-10-15",
    },
  });
  assert.equal(corrected.version, 2);
  assert.equal(corrected.dueDate, "2026-10-15");
  await f.editMeeting();
  f.sourceChanged();
  const replay = await f.service.accept(f.actor, "accept-command-1", "commitment", body);
  assert.equal(replay.id, item.id);
  assert.equal(replay.text, "Preserved human correction");
  assert.equal((await f.service.read(f.actor, item.id, "commitment")).evidenceStatus, "changed");
  const events = await scoped(
    f.actor.workspaceId,
    async (c) => (await c.query("SELECT event FROM outbox")).rows,
  );
  assert.equal(events.length, 2);
  assert.equal(JSON.stringify(events).includes("Preserved human correction"), false);
  assert.equal(await store.get(randomUUID(), item.id), undefined);
});
test("project membership is not read access; reader can read only explicit shared meeting and cannot accept/correct", async () => {
  const f = await fixture(),
    item = await f.service.accept(f.actor, "accept-command-2", "commitment", f.body()),
    reader = { ...f.actor, actorId: randomUUID() };
  await assert.rejects(
    f.service.list(reader, "commitment", { kind: "project", id: randomUUID() }),
    (e) => e instanceof AppError && e.status === 404,
  );
  f.share();
  assert.equal((await f.service.read(reader, item.id, "commitment")).id, item.id);
  await assert.rejects(
    f.service.accept(reader, "reader-accept-key", "commitment", f.body()),
    (e) => e instanceof AppError && e.status === 403,
  );
  await assert.rejects(
    f.service.status(reader, item.id, "commitment", "reader-status-key", {
      expectedVersion: 1,
      confirmed: true,
      state: "completed",
    }),
    (e) => e instanceof AppError && e.status === 403,
  );
  f.revoke();
  await assert.rejects(
    f.service.read(f.actor, item.id, "commitment"),
    (e) => e instanceof AppError && e.status === 404,
  );
});
test("stale evidence/source/member ownership and optimistic conflicts prevent unreviewed mutation", async () => {
  const f = await fixture();
  f.badMember();
  await assert.rejects(
    f.service.accept(f.actor, "invalid-member-key", "commitment", {
      ...f.body(),
      content: { ...f.body().content, ownerId: f.assignee },
    }),
    (e) => e instanceof AppError && e.status === 403,
  );
  f.advanceRevision();
  await assert.rejects(
    f.service.accept(f.actor, "invalid-source-key", "commitment", f.body()),
    (e) => e instanceof AppError && e.code === "SOURCE_EVIDENCE_CHANGED",
  );
  const second = await fixture(),
    item = await second.service.accept(second.actor, "accept-command-3", "decision", {
      ...second.body(),
      proposal: null,
    });
  const completed = await second.service.status(
    second.actor,
    item.id,
    "decision",
    "status-command-3",
    { expectedVersion: 1, confirmed: true, state: "superseded" },
  );
  assert.equal(completed.state, "superseded");
  await assert.rejects(
    second.service.status(second.actor, item.id, "decision", "stale-status-key", {
      expectedVersion: 1,
      confirmed: true,
      state: "accepted",
    }),
    (e) => e instanceof AppError && e.code === "VERSION_CONFLICT",
  );
  await scoped(second.actor.workspaceId, (c) =>
    c.query("UPDATE meetings SET blocked=true,notes=$2 WHERE id=$1", [second.meetingId, ""]),
  );
  assert.equal(await store.get(second.actor.workspaceId, item.id), undefined);
  await assert.rejects(
    second.service.accept(second.actor, "accept-command-3", "decision", {
      ...second.body(),
      proposal: null,
    }),
    (e) => e instanceof AppError && e.status === 404,
  );
});

test("owner deletion atomically removes accepted text and blocks stale review command replay", async () => {
  const f = await fixture(),
    body = f.body(),
    item = await f.service.accept(f.actor, "deletion-review-key", "commitment", body);
  const deletion = await new PostgresDeletions(pool).request(
    f.actor,
    "delete-reviewed-meeting",
    { meetingId: f.meetingId, expectedVersion: 1 },
    ["ingest", "intelligence"],
  );
  assert.equal(deletion.state, "pending");
  const rows = await scoped(
    f.actor.workspaceId,
    async (c) =>
      (await c.query("SELECT id FROM accepted_items WHERE meeting_id=$1", [f.meetingId])).rows,
  );
  assert.equal(rows.length, 0);
  assert.equal(await store.get(f.actor.workspaceId, item.id), undefined);
  await assert.rejects(
    f.service.accept(f.actor, "deletion-review-key", "commitment", body),
    (e) => e instanceof AppError && e.status === 404,
  );
  await assert.rejects(
    f.service.accept(f.actor, "new-review-after-deletion", "commitment", body),
    (e) => e instanceof AppError && e.status === 404,
  );
});

test("public review routes and Workflow-only source reject wrong actors, missing confirmation and deleted source", async () => {
  const f = await fixture(),
    app = Fastify({ logger: false });
  installErrorHandler(app);
  const authenticate = async (token: string) => {
    if (token !== "owner-fixture") throw new AppError("UNAUTHENTICATED", 401);
    return f.actor;
  };
  commitmentRoutes(app, f.service, authenticate, async (token) => {
    if (token !== "workflow-fixture") throw new AppError("UNAUTHENTICATED_SERVICE", 401);
    return f.actor;
  });
  const path = `/api/v3/workspaces/${f.actor.workspaceId}/commitments`,
    headers = { authorization: "Bearer owner-fixture", "idempotency-key": "http-review-command" };
  try {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: path,
          headers,
          payload: { ...f.body(), confirmed: false },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: path,
          headers: { authorization: "Bearer owner-fixture" },
          payload: f.body(),
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/api/v3/workspaces/${randomUUID()}/commitments`,
          headers,
        })
      ).statusCode,
      403,
    );
    const response = await app.inject({ method: "POST", url: path, headers, payload: f.body() });
    assert.equal(response.statusCode, 201);
    const item = response.json(),
      source = `/internal/workspaces/${f.actor.workspaceId}/commitments/${item.id}/source`;
    assert.equal(
      (await app.inject({ url: source, headers: { authorization: "Bearer owner-fixture" } }))
        .statusCode,
      401,
    );
    const proof = await app.inject({
      url: source,
      headers: { authorization: "Bearer workflow-fixture" },
    });
    assert.equal(proof.statusCode, 200);
    assert.equal(proof.json().humanReviewed, true);
    assert.equal(proof.json().version, 1);
    assert.equal(proof.json().evidenceStatus, "current");
    f.sourceChanged();
    assert.equal(
      (
        await app.inject({ url: source, headers: { authorization: "Bearer workflow-fixture" } })
      ).json().evidenceStatus,
      "changed",
    );
    f.revoke();
    assert.equal(
      (await app.inject({ url: source, headers: { authorization: "Bearer workflow-fixture" } }))
        .statusCode,
      404,
    );
  } finally {
    await app.close();
  }
});
