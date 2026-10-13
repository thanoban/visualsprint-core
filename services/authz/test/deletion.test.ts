import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AppError } from "@visualsprint/platform";
import { OpenFgaPolicy } from "../src/policy.js";
import { OpenFgaMeetingPurge } from "../src/deletion-provider.js";
test("persistent deletion barrier denies stale contextual facts before engine IO and fails closed on outage", async () => {
  const actor = { workspaceId: randomUUID(), actorId: randomUUID(), sessionId: "fixture" },
    facts = {
      meetingId: randomUUID(),
      ownerId: actor.actorId,
      reader: false,
      blocked: false,
      activeMember: true,
      relation: "can_view" as const,
    };
  const model = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  assert.equal(
    await new OpenFgaPolicy("http://127.0.0.1:1", "fixture", model, model, {
      async blocked() {
        return true;
      },
    }).check(actor, facts),
    false,
  );
  await assert.rejects(
    new OpenFgaPolicy("http://127.0.0.1:1", "fixture", model, model, {
      async blocked() {
        throw new Error("private database details");
      },
    }).check(actor, facts),
    (e) => e instanceof AppError && e.code === "AUTHZ_UNAVAILABLE",
  );
});
test("purge validates exact meeting scope and never follows provider continuations after deleting shifted rows", async () => {
  const ws = randomUUID(),
    meetingId = randomUUID(),
    object = `meeting:${ws}/${meetingId}`,
    model = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  let reads = 0,
    writes = 0;
  const purge = new OpenFgaMeetingPurge(
    "http://127.0.0.1:4180",
    "fixture",
    model,
    model,
    async (url, init) => {
      assert.equal(init?.redirect, "error");
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith("/read")) {
        reads++;
        assert.equal(body.tuple_key.object, object);
        assert.equal(body.continuation_token, undefined);
        return Response.json(
          reads === 1
            ? {
                tuples: [{ key: { user: "user:" + randomUUID(), relation: "owner", object } }],
                continuation_token: "opaque-provider-cursor",
              }
            : { tuples: [], continuation_token: "" },
        );
      }
      writes++;
      assert.equal(body.deletes.tuple_keys.length, 1);
      assert.equal(body.deletes.tuple_keys[0].object, object);
      return Response.json({});
    },
  );
  await purge.remove(ws, meetingId);
  assert.equal(reads, 2);
  assert.equal(writes, 1);
  const unsafe = new OpenFgaMeetingPurge(
    "http://127.0.0.1:4180",
    "fixture",
    model,
    model,
    async () =>
      Response.json({
        tuples: [
          {
            key: {
              user: "user:" + randomUUID(),
              relation: "owner",
              object: "meeting:wrong/target",
            },
          },
        ],
      }),
  );
  await assert.rejects(
    unsafe.remove(ws, meetingId),
    (e) => e instanceof AppError && e.code === "AUTHZ_CLEANUP_SCOPE_MISMATCH",
  );
});
