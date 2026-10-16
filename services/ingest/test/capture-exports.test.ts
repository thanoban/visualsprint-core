import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AppError, type Actor } from "@visualsprint/platform";
import { CaptureService } from "../src/application/capture-service.js";
import type { CaptureTransaction } from "../src/application/ports.js";
import { ingestApp } from "../src/http/app.js";
import { RecallSignatures } from "../src/infrastructure/webhook-signature.js";

function fixture(count = 0) {
  const actor: Actor = { workspaceId: randomUUID(), actorId: randomUUID(), sessionId: "owner" };
  const meetingId = randomUUID();
  let reads = 0,
    queries = 0,
    revokeAfterQuery = false;
  const captures = Array.from({ length: count }, () => ({
    id: randomUUID(),
    version: 1,
    state: "complete" as const,
    coverage: "no_detected_gaps" as const,
  }));
  const tx = {
    async exportCaptures(target: string) {
      assert.equal(target, meetingId);
      queries++;
      return captures;
    },
  } as CaptureTransaction;
  const service = new CaptureService(
    {
      async scoped(ws, work) {
        assert.equal(ws, actor.workspaceId);
        return work(tx);
      },
      async attempt() {
        throw new Error("unused attempt");
      },
    },
    {
      async read(candidate, target) {
        reads++;
        if (
          candidate.actorId !== actor.actorId ||
          target !== meetingId ||
          (revokeAfterQuery && queries)
        )
          throw new AppError("FORBIDDEN", 403);
      },
      async capture() {
        throw new Error("no capture");
      },
      async manage() {
        throw new Error("no mutation");
      },
    },
    {
      async lookup() {
        throw new Error("no quota");
      },
      async reserve() {
        throw new Error("no quota");
      },
      async release() {},
      async settle() {},
    },
    {
      async create() {
        throw new Error("no bot");
      },
      async inspect() {
        return null;
      },
      async findAttempt() {
        return { kind: "unknown" };
      },
      async leave() {
        return "accepted";
      },
    },
    "https://fixture.example/webhooks",
  );
  return {
    actor,
    meetingId,
    captures,
    service,
    get reads() {
      return reads;
    },
    get queries() {
      return queries;
    },
    set revokeAfterQuery(value: boolean) {
      revokeAfterQuery = value;
    },
  };
}

test("complete export manifest covers empty/exact-cap results and refuses overflow rather than clipping", async () => {
  for (const count of [0, 100]) {
    const f = fixture(count),
      result = await f.service.exportCaptures(f.actor, f.meetingId);
    assert.deepEqual(result, { meetingId: f.meetingId, complete: true, captures: f.captures });
    assert.equal(f.reads, 2);
    assert.equal(f.queries, 1);
    assert.deepEqual(Object.keys(result).sort(), ["captures", "complete", "meetingId"]);
    if (result.captures[0])
      assert.deepEqual(Object.keys(result.captures[0]).sort(), [
        "coverage",
        "id",
        "state",
        "version",
      ]);
  }
  const f = fixture(101);
  await assert.rejects(
    f.service.exportCaptures(f.actor, f.meetingId),
    /CAPTURE_EXPORT_SCOPE_TOO_LARGE/,
  );
});

test("export rechecks current meeting permission after lookup and rejects operation or unrelated actors", async () => {
  const f = fixture(1);
  f.revokeAfterQuery = true;
  await assert.rejects(f.service.exportCaptures(f.actor, f.meetingId), /FORBIDDEN/);
  assert.equal(f.reads, 2);
  for (const actor of [
    { ...f.actor, operationGrantId: randomUUID() },
    { ...f.actor, sessionId: `operation:${randomUUID()}` },
  ])
    await assert.rejects(f.service.exportCaptures(actor, f.meetingId), /FORBIDDEN/);
  const other = fixture();
  await assert.rejects(
    other.service.exportCaptures({ ...other.actor, actorId: randomUUID() }, other.meetingId),
    /FORBIDDEN/,
  );
  assert.equal(other.queries, 0);
});

test("native export route requires dedicated Reporting authentication and binds tenant", async () => {
  const f = fixture();
  const app = ingestApp(
    f.service,
    async () => f.actor,
    new RecallSignatures([`whsec_${Buffer.alloc(32, 1).toString("base64")}`]),
    undefined,
    undefined,
    undefined,
    undefined,
    async (token) => {
      if (token !== "reporting") throw new AppError("UNAUTHENTICATED_SERVICE", 401);
      return f.actor;
    },
  );
  const path = `/internal/workspaces/${f.actor.workspaceId}/meetings/${f.meetingId}/export-captures`;
  try {
    const accepted = await app.inject({
      method: "GET",
      url: path,
      headers: { authorization: "Bearer reporting" },
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.json().complete, true);
    assert.equal(
      (await app.inject({ method: "GET", url: path, headers: { authorization: "Bearer gateway" } }))
        .statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: path.replace(f.actor.workspaceId, randomUUID()),
          headers: { authorization: "Bearer reporting" },
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
  }
});
