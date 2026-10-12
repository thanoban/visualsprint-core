import test from "node:test";
import assert from "node:assert/strict";
import { RecallProvider, buildRecallRequest } from "../src/infrastructure/recall.js";

const attemptId = "ab1ecfc0-9abd-45b0-8d6b-d627d470b02c";
const providerId = "a86182d0-70f0-4206-b30e-66788c908dca";
const bot = {
  id: providerId,
  metadata: { attempt_id: attemptId },
  status_changes: [
    { code: "call_ended", created_at: "2026-10-12T01:00:00Z" },
    { code: "joining_call", created_at: "2026-10-12T00:00:00Z" },
  ],
};
test("attempt reconciliation filters opaque metadata and uses newest timestamp, not array order", async () => {
  const provider = new RecallProvider("fixture", "us-west-2", async (url) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.origin, "https://us-west-2.recall.ai");
    assert.equal(parsed.searchParams.get("metadata__attempt_id"), attemptId);
    return Response.json({ results: [bot], next: null });
  });
  assert.deepEqual(await provider.findAttempt(attemptId), {
    kind: "found",
    bot: {
      providerId,
      status: "call_ended",
      occurredAt: "2026-10-12T01:00:00Z",
    },
  });
});
test("reconciliation never follows pagination, guesses a duplicate or treats absence as creation permission", async () => {
  for (const result of [
    { results: [bot, bot], next: null },
    { results: [bot], next: "https://evil.example" },
    { results: [{ ...bot, metadata: { attempt_id: providerId } }], next: null },
  ]) {
    let calls = 0;
    const provider = new RecallProvider("fixture", "us-west-2", async () => {
      calls++;
      return Response.json(result);
    });
    assert.deepEqual(await provider.findAttempt(attemptId), { kind: "unknown" });
    assert.equal(calls, 1);
  }
  const empty = new RecallProvider("fixture", "us-west-2", async () =>
    Response.json({ results: [], next: null }),
  );
  assert.deepEqual(await empty.findAttempt(attemptId), { kind: "not_found" });
});
test("a successful leave response confirms only acceptance; timeout and rejection remain unknown", async () => {
  for (const status of [200, 400, 503]) {
    const provider = new RecallProvider("fixture", "us-west-2", async (url, init) => {
      assert.equal(String(url), `https://us-west-2.recall.ai/api/v1/bot/${providerId}/leave_call/`);
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      return new Response(null, { status });
    });
    assert.equal(await provider.leave(providerId), status === 200 ? "accepted" : "unknown");
  }
  const timeout = new RecallProvider("fixture", "us-west-2", async () => {
    throw new Error("private");
  });
  assert.equal(await timeout.leave(providerId), "unknown");
});
test("capture timers preserve quiet meetings and give empty rooms a 90-second grace", () => {
  const input = {
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    attemptId,
    transcriptWebhookUrl: "https://api.example.com/webhooks/recall",
  };
  const request = buildRecallRequest(input);
  assert.deepEqual(request.automatic_leave.everyone_left_timeout, {
    timeout: 90,
    activate_after: 0,
  });
  assert.equal(request.automatic_leave.in_call_recording_timeout, 14400);
  assert.ok(request.automatic_leave.silence_detection.activate_after > 14400);
  assert.ok(request.automatic_leave.bot_detection.using_participant_events.activate_after > 14400);
  assert.equal(
    buildRecallRequest({ ...input, maxDurationSeconds: 600 }).automatic_leave
      .in_call_recording_timeout,
    600,
  );
  for (const maxDurationSeconds of [0, -1, 14401, NaN, 1.5])
    assert.throws(() => buildRecallRequest({ ...input, maxDurationSeconds }));
});
