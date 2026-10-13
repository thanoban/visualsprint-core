import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  AppError,
  databasePool,
  migrate,
  assertRuntimeRole,
  type Actor,
} from "@visualsprint/platform";
import { eventEnvelope } from "@visualsprint/contracts";
import { PostgresWorkflow } from "../../src/infrastructure/store.js";
import { WorkflowService } from "../../src/application/workflow.js";
import { workflowApp } from "../../src/http/app.js";
import type { ExecutionResult, ReconciliationResult } from "../../src/domain/action.js";
const migrationPool = databasePool(
  process.env.WORKFLOW_TEST_MIGRATION_URL ??
    "postgres://vs_workflow_migration:local-migration-only@127.0.0.1:55440/workflow",
  1,
);
const pool = databasePool(
  process.env.WORKFLOW_TEST_DATABASE_URL ??
    "postgres://vs_workflow_runtime:local-runtime-only@127.0.0.1:55440/workflow",
  3,
);
const repository = new PostgresWorkflow(pool);
before(async () => {
  await migrate(migrationPool, fileURLToPath(new URL("../../migrations", import.meta.url)));
  await assertRuntimeRole(pool);
});
after(async () => {
  await pool.end();
  await migrationPool.end();
});
function fixture() {
  const actor: Actor = {
    workspaceId: randomUUID(),
    actorId: randomUUID(),
    sessionId: randomUUID(),
  };
  let sourceVersion = 1,
    allowed = true,
    creates = 0,
    lookups = 0;
  let result: ExecutionResult = { state: "confirmed", externalId: "task-1" };
  let commitmentVersion = 1;
  let evidenceStatus: "current" | "changed" = "current";
  let lookup: ReconciliationResult = { state: "pending" };
  const service = new WorkflowService(
    repository,
    {
      async requireSource() {
        if (!allowed) throw new AppError("FORBIDDEN", 403);
        return { version: sourceVersion, ownerId: actor.actorId };
      },
      async requireCommitment(_actor, commitmentId) {
        if (!allowed) throw new AppError("FORBIDDEN", 403);
        return { id: commitmentId, meetingId: input.source.meetingId, version: commitmentVersion,
          humanReviewed: true, state: "open", evidenceStatus };
      },
    },
    {
      async execute() {
        creates++;
        return result;
      },
      async reconcile() {
        lookups++;
        return lookup;
      },
    },
  );
  const input = {
    connectionId: randomUUID(),
    provider: "jira" as const,
    destination: "project/CORE",
    payload: { title: "Ship feature", description: "Reviewed content", dueDate: null },
    source: { meetingId: randomUUID(), revision: 1 },
  };
  return {
    actor,
    service,
    input,
    get creates() {
      return creates;
    },
    get lookups() {
      return lookups;
    },
    set result(value: ExecutionResult) {
      result = value;
    },
    set lookup(value: ReconciliationResult) {
      lookup = value;
    },
    set sourceVersion(value: number) {
      sourceVersion = value;
    },
    set allowed(value: boolean) {
      allowed = value;
    },
    set commitmentVersion(value: number) { commitmentVersion = value; },
    set evidenceStatus(value: "current" | "changed") { evidenceStatus = value; },
    async approved() {
      const proposed = await service.propose(actor, randomUUID(), input);
      return service.approve(actor, proposed.id, randomUUID(), {
        expectedVersion: proposed.version,
        confirmed: true,
      });
    },
    async queued() {
      const approved = await this.approved();
      return service.execute(actor, approved.id, randomUUID(), {
        expectedVersion: approved.version,
      });
    },
  };
}
test("accepted commitment revisions and changed evidence invalidate approvals before external execution", async () => {
  const f = fixture();
  const input = { ...f.input, source: { ...f.input.source, commitment: { id: randomUUID(), version: 1 } } };
  const draft = await f.service.propose(f.actor, randomUUID(), input);
  f.commitmentVersion = 2;
  await assert.rejects(f.service.approve(f.actor, draft.id, randomUUID(), {
    expectedVersion: draft.version, confirmed: true,
  }), /COMMITMENT_REVISION_CHANGED/);
  f.commitmentVersion = 1;
  const approved = await f.service.approve(f.actor, draft.id, randomUUID(), {
    expectedVersion: draft.version, confirmed: true,
  });
  const operation = await f.service.execute(f.actor, approved.id, randomUUID(), {
    expectedVersion: approved.version,
  });
  f.evidenceStatus = "changed";
  await f.service.work(f.actor.workspaceId, operation.id);
  assert.equal(f.creates, 0);
  const status = await f.service.status(f.actor, operation.id);
  assert.equal(status.state, "cancelled");
  assert.equal(status.errorCode, "COMMITMENT_REVISION_CHANGED");
});

test("signed deletion purges private approvals and payloads, preserves only execution references and fences recreation", async () => {
  const f = fixture();
  f.result = { state: "unknown" };
  const op = await f.queued();
  await f.service.work(f.actor.workspaceId, op.id);
  const deletionId = randomUUID();
  const app = workflowApp(
    f.service,
    async () => f.actor,
    undefined,
    async (token) => {
      if (token !== "workspace-proof") throw new AppError("UNAUTHENTICATED_SERVICE", 401);
      return f.actor;
    },
  );
  try {
    const url = `/internal/workspaces/${f.actor.workspaceId}/deletions/${deletionId}`;
    const payload = { meetingId: f.input.source.meetingId, sourceVersion: 1 };
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          payload,
          headers: { authorization: "Bearer untrusted" },
        })
      ).statusCode,
      401,
    );
    for (let n = 0; n < 2; n++)
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url,
            payload,
            headers: { authorization: "Bearer workspace-proof" },
          })
        ).statusCode,
        200,
      );
    await assert.rejects(f.service.status(f.actor, op.id), /NOT_FOUND/);
    await assert.rejects(f.service.propose(f.actor, randomUUID(), f.input), /NOT_FOUND/);
    await assert.rejects(
      f.service.deleteMeeting(f.actor, deletionId, { meetingId: randomUUID(), sourceVersion: 1 }),
      /DELETION_TARGET_CONFLICT/,
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id',$1,true)", [f.actor.workspaceId]);
      for (const table of ["actions", "approvals", "operations", "commands"])
        assert.equal((await client.query(`SELECT 1 FROM ${table}`)).rowCount, 0);
      const refs = (await client.query("SELECT * FROM cleanup_executions")).rows;
      assert.equal(refs.length, 1);
      assert.equal(refs[0].operation_id, op.id);
      assert.equal(JSON.stringify(refs).includes(f.input.payload.title), false);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  } finally {
    await app.close();
  }
});
test("outbox replays the same immutable event after lost broker acknowledgement without releasing an active lease", async () => {
  const f = fixture();
  await f.approved();
  const seen: string[] = [];
  await assert.rejects(
    repository.publish(f.actor.workspaceId, {
      async publish(event) {
        seen.push(event.eventId);
        throw new Error("BROKER_ACK_UNKNOWN");
      },
    }),
    /BROKER_ACK_UNKNOWN/,
  );
  assert.equal(
    await repository.publish(f.actor.workspaceId, {
      async publish() {
        throw new Error("LEASE_BROKEN");
      },
    }),
    0,
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id',$1,true)", [f.actor.workspaceId]);
    await client.query("UPDATE outbox SET lease_until=now()-interval '1 second'");
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  assert.equal(
    await repository.publish(f.actor.workspaceId, {
      async publish(event) {
        seen.push(event.eventId);
        eventEnvelope.parse(event);
      },
    }),
    1,
  );
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1]);
  assert.equal(
    await repository.publish(f.actor.workspaceId, {
      async publish() {
        throw new Error("DUPLICATE_COMPLETION");
      },
    }),
    0,
  );
});
test("Integration-only reference lookup allows existing unknown/confirmed records after revocation but grants no fresh execution", async () => {
  const f = fixture();
  f.result = { state: "unknown" };
  const op = await f.queued();
  await assert.rejects(
    f.service.referenceContext(f.actor, op.id),
    /REFERENCE_LOOKUP_NOT_AVAILABLE/,
  );
  await f.service.work(f.actor.workspaceId, op.id);
  const action = await f.service.read(f.actor, op.actionId);
  await f.service.revoke(f.actor, action.id, "revoke", { expectedVersion: action.version });
  const app = workflowApp(
    f.service,
    async () => f.actor,
    async (token) => {
      if (token !== "integration-proof") throw new AppError("UNAUTHENTICATED_SERVICE", 401);
      return f.actor;
    },
  );
  try {
    const path = `/internal/workspaces/${f.actor.workspaceId}/operations/${op.id}`;
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: path + "/reference-context",
          headers: { authorization: "Bearer untrusted" },
        })
      ).statusCode,
      401,
    );
    const response = await app.inject({
      method: "GET",
      url: path + "/reference-context",
      headers: { authorization: "Bearer integration-proof" },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      operationId: op.id,
      approvalId: op.approvalId,
      payloadHash: op.payloadHash,
      ...f.input,
    });
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: path + "/approval",
          headers: { authorization: "Bearer integration-proof" },
        })
      ).statusCode,
      409,
    );
    f.allowed = false;
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: path + "/reference-context",
          headers: { authorization: "Bearer integration-proof" },
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
  }
});
test("exact approval, command replay and one immutable operation per approval", async () => {
  const f = fixture();
  const action = await f.service.propose(f.actor, "propose", f.input);
  assert.equal((await f.service.propose(f.actor, "propose", f.input)).id, action.id);
  await assert.rejects(
    f.service.propose(f.actor, "propose", { ...f.input, destination: "OTHER" }),
    /IDEMPOTENCY_CONFLICT/,
  );
  await assert.rejects(
    f.service.execute(f.actor, action.id, "execute", { expectedVersion: 1 }),
    /APPROVAL_REQUIRED/,
  );
  const approved = await f.service.approve(f.actor, action.id, "approve", {
    expectedVersion: 1,
    confirmed: true,
  });
  const op = await f.service.execute(f.actor, approved.id, "execute-a", {
    expectedVersion: approved.version,
  });
  assert.equal(
    (
      await f.service.execute(f.actor, approved.id, "execute-b", {
        expectedVersion: approved.version,
      })
    ).id,
    op.id,
  );
  await Promise.all([
    f.service.work(f.actor.workspaceId, op.id),
    f.service.work(f.actor.workspaceId, op.id),
  ]);
  assert.equal(f.creates, 1);
  assert.equal((await f.service.status(f.actor, op.id)).state, "confirmed");
  await repository.reschedule(f.actor.workspaceId, op.id);
  assert.equal(
    (await pool.query("SELECT 1 FROM operation_work_index WHERE operation_id=$1", [op.id]))
      .rowCount,
    0,
  );
});
test("changed payload invalidates approval and cancels queued operation", async () => {
  const f = fixture();
  const approved = await f.approved();
  const op = await f.service.execute(f.actor, approved.id, randomUUID(), {
    expectedVersion: approved.version,
  });
  const edited = await f.service.edit(f.actor, approved.id, randomUUID(), {
    expectedVersion: approved.version,
    action: { ...f.input, payload: { ...f.input.payload, title: "Different task" } },
  });
  assert.equal(edited.state, "draft");
  assert.equal(edited.approvalId, null);
  assert.equal((await f.service.status(f.actor, op.id)).state, "cancelled");
  await f.service.work(f.actor.workspaceId, op.id);
  assert.equal(f.creates, 0);
  await assert.rejects(
    f.service.execute(f.actor, edited.id, randomUUID(), { expectedVersion: edited.version }),
    /APPROVAL_REQUIRED/,
  );
});
test("unknown execution only reconciles; definitive absence permits one later retry", async () => {
  const f = fixture();
  f.result = { state: "unknown" };
  const op = await f.queued();
  await f.service.work(f.actor.workspaceId, op.id);
  assert.equal((await f.service.status(f.actor, op.id)).state, "unknown");
  await f.service.work(f.actor.workspaceId, op.id);
  assert.equal(f.creates, 1);
  assert.equal(f.lookups, 1);
  f.lookup = { state: "not_created" };
  await f.service.work(f.actor.workspaceId, op.id);
  assert.equal((await f.service.status(f.actor, op.id)).state, "queued");
  f.result = { state: "confirmed", externalId: "task-2" };
  await f.service.work(f.actor.workspaceId, op.id);
  assert.equal(f.creates, 2);
  assert.equal((await f.service.status(f.actor, op.id)).externalId, "task-2");
});
test("revision/access changes prevent dispatch while revocation preserves uncertain outcome lookup", async () => {
  const f = fixture();
  const op = await f.queued();
  f.sourceVersion = 2;
  await f.service.work(f.actor.workspaceId, op.id);
  assert.equal(f.creates, 0);
  assert.equal((await f.service.status(f.actor, op.id)).state, "cancelled");
  const g = fixture();
  g.result = { state: "unknown" };
  const uncertain = await g.queued();
  await g.service.work(g.actor.workspaceId, uncertain.id);
  const action = await g.service.read(g.actor, uncertain.actionId);
  await g.service.revoke(g.actor, action.id, "revoke", { expectedVersion: action.version });
  g.allowed = false;
  g.lookup = { state: "confirmed", externalId: "existing-task" };
  await g.service.work(g.actor.workspaceId, uncertain.id);
  assert.equal(g.creates, 1);
  assert.equal(g.lookups, 1);
  g.allowed = true;
  assert.equal((await g.service.status(g.actor, uncertain.id)).externalId, "existing-task");
});
test("database forbids forged operation snapshots and edits to approvals; RLS isolates tenants", async () => {
  const f = fixture();
  const op = await f.queued();
  await assert.rejects(
    repository.transaction(f.actor, async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id',$1,true)", [f.actor.workspaceId]);
        await client.query("UPDATE operations SET input=$2 WHERE id=$1", [
          op.id,
          JSON.stringify({ ...f.input, destination: "OTHER" }),
        ]);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }),
    /APPROVAL_SNAPSHOT_MISMATCH|IMMUTABLE_EXECUTION_INTENT/,
  );
  await assert.rejects(
    repository.transaction(f.actor, async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id',$1,true)", [f.actor.workspaceId]);
        await client.query("UPDATE approvals SET input='{}' WHERE id=$1", [op.approvalId]);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }),
    /permission denied/,
  );
  await assert.rejects(
    repository.transaction({ ...f.actor, workspaceId: randomUUID() }, (tx) => tx.operation(op.id)),
    /NOT_FOUND/,
  );
  assert.equal((await pool.query("SELECT * FROM operations WHERE id=$1", [op.id])).rowCount, 0);
});
test("expired dispatch lease recovers as reconciliation; stale worker cannot finish", async () => {
  const f = fixture();
  const op = await f.queued();
  const claimed = await repository.transaction(f.actor, (tx) => tx.claim(op.id));
  assert.ok(claimed);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id',$1,true)", [f.actor.workspaceId]);
    await client.query("UPDATE operations SET lease_until=now()-interval '1 second' WHERE id=$1", [
      op.id,
    ]);
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  await f.service.work(f.actor.workspaceId, op.id);
  assert.equal(f.creates, 0);
  assert.equal(f.lookups, 1);
  await assert.rejects(
    repository.transaction(f.actor, (tx) => tx.finish(claimed, "confirmed", "late", null)),
    /STALE_WORKER/,
  );
});
test("HTTP denies other owners, workspace mismatches, operation grants and untrusted internal calls; outbox contains no text", async () => {
  const f = fixture();
  const action = await f.approved();
  const op = await f.service.execute(f.actor, action.id, randomUUID(), {
    expectedVersion: action.version,
  });
  const app = workflowApp(f.service, async (token) =>
    token === "other"
      ? { ...f.actor, actorId: randomUUID() }
      : token === "grant"
        ? { ...f.actor, operationGrantId: randomUUID() }
        : f.actor,
  );
  try {
    for (const [token, workspaceId, status] of [
      ["other", f.actor.workspaceId, 404],
      ["grant", f.actor.workspaceId, 403],
      ["owner", randomUUID(), 403],
    ] as const) {
      const response = await app.inject({
        method: "GET",
        url: `/api/v3/workspaces/${workspaceId}/actions/${action.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(response.statusCode, status);
    }
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/internal/workspaces/${f.actor.workspaceId}/operations/${op.id}/approval`,
          headers: { authorization: "Bearer owner" },
        })
      ).statusCode,
      401,
    );
    await f.service.work(f.actor.workspaceId, op.id);
    await repository.transaction(f.actor, async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id',$1,true)", [f.actor.workspaceId]);
        const events = (await client.query("SELECT event FROM outbox")).rows;
        assert.ok(events.length >= 2);
        for (const { event } of events) {
          eventEnvelope.parse(event);
          assert.equal(JSON.stringify(event).includes(f.input.payload.title), false);
        }
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    });
  } finally {
    await app.close();
  }
});
