import test from "node:test";
import assert from "node:assert/strict";
import { finalOutcome, shouldLeave, transitionCapture } from "../src/domain/capture.js";
import { parseMeetingLink } from "../src/domain/meeting-url.js";
import { buildRecallRequest, RecallProvider } from "../src/infrastructure/recall.js";

const attemptId = "ab1ecfc0-9abd-45b0-8d6b-d627d470b02c";
const input = { meetingUrl: "https://meet.google.com/abc-defg-hij", attemptId,
  transcriptWebhookUrl: "https://api.example.com/webhooks/recall" };

test("terminal capture states cannot regress on delayed callbacks", () => {
  for (const state of ["complete", "partial", "failed", "cancelled"] as const) {
    assert.throws(() => transitionCapture(state, "capturing"), /INVALID_CAPTURE_TRANSITION/);
    assert.equal(transitionCapture(state, state), state);
  }
});
test("ambiguous dispatch cannot be blindly re-dispatched", () => {
  assert.throws(() => transitionCapture("dispatch_unknown", "dispatching"));
  assert.equal(transitionCapture("dispatch_unknown", "joining"), "joining");
  // Reconciliation may discover the bot only after it has already left.
  assert.equal(transitionCapture("dispatch_unknown", "finalizing"), "finalizing");
});
test("finalization requires confirmed departure and a drained stream", () => {
  const finalized = { stopConfirmed: true, drainComplete: true, coverage: "no_detected_gaps" as const,
    finalSegmentCount: 12, silenceConfirmed: false };
  assert.equal(finalOutcome(finalized), "complete");
  assert.equal(finalOutcome({ ...finalized, coverage: "known_gaps" }), "partial");
  assert.equal(finalOutcome({ ...finalized, coverage: "unknown" }), "partial");
  assert.equal(finalOutcome({ ...finalized, finalSegmentCount: 0 }), "failed");
  assert.throws(() => finalOutcome({ ...finalized, stopConfirmed: false }));
  assert.throws(() => finalOutcome({ ...finalized, drainComplete: false }));
});
test("absence of transcript does not establish silence", () => {
  assert.equal(finalOutcome({ stopConfirmed: true, drainComplete: true, coverage: "no_detected_gaps",
    finalSegmentCount: 0, silenceConfirmed: true }), "complete");
});
test("meeting continues with participants; empty meeting has 90-second grace", () => {
  const state = { explicitEnd: false, stopRequested: false, hostRemoved: false,
    nonBotParticipants: 0, aloneSinceMs: 1000, nowMs: 90_999 };
  assert.equal(shouldLeave(state), false);
  assert.equal(shouldLeave({ ...state, nowMs: 91_000 }), true);
  assert.equal(shouldLeave({ ...state, nonBotParticipants: 1, nowMs: 1_000_000 }), false);
  assert.equal(shouldLeave({ ...state, nonBotParticipants: null, nowMs: 1_000_000 }), false);
  assert.equal(shouldLeave({ ...state, explicitEnd: true }), true);
  assert.equal(shouldLeave({ ...state, stopRequested: true }), true);
  assert.equal(shouldLeave({ ...state, hostRemoved: true }), true);
});
test("supported provider links preserve embedded credentials", () => {
  const zoom = "https://us02web.zoom.us/j/12345678901?pwd=keep%2Bthis";
  assert.equal(parseMeetingLink(zoom).url, zoom);
  const teams = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=keep";
  assert.equal(parseMeetingLink(teams).url, teams);
  assert.equal(parseMeetingLink(input.meetingUrl).platform, "google_meet");
});
test("URL validation rejects lookalike hosts, credentials, private endpoints and unsupported paths", () => {
  for (const url of [
    "http://meet.google.com/abc-defg-hij", "https://meet.google.com.evil.test/abc-defg-hij",
    "https://user:password@meet.google.com/abc-defg-hij",
    "https://meet.google.com:8443/abc-defg-hij", "https://127.0.0.1/j/12345678901",
    "https://evilzoom.us/j/12345678901", "https://zoom.us/profile", "file:///etc/passwd",
    "https://teams.microsoft.com/meet/12345unexpected",
  ]) assert.throws(() => parseMeetingLink(url), /INVALID_LINK/);
});
test("all bot creations use explicit zero retention and transcript-only English streaming", () => {
  const config = buildRecallRequest(input);
  assert.equal(config.recording_config.retention, null);
  assert.equal(config.recording_config.video_mixed_mp4, null);
  assert.equal(config.recording_config.audio_mixed_mp3, null);
  assert.deepEqual(config.recording_config.transcript.provider,
    { recallai_streaming: { mode: "prioritize_low_latency", language_code: "en" } });
  assert.deepEqual(config.recording_config.realtime_endpoints[0]?.events, ["transcript.data"]);
  assert.throws(() => buildRecallRequest({ ...input, transcriptWebhookUrl: "http://api.example.com" }));
});

test("create sends exactly one request; timeouts stay ambiguous and contain no provider details", async () => {
  let calls = 0;
  const transport: typeof fetch = async () => { calls++; throw new Error("sensitive provider details"); };
  const provider = new RecallProvider("test-key", "us-west-2", transport);
  assert.deepEqual(await provider.create(input), { kind: "unknown" });
  assert.equal(calls, 1);
});
test("capacity is distinct from permission failures or malformed successes", async () => {
  for (const [status, expected] of [
    [507, { kind: "capacity", retryAfterSeconds: 30 }],
    [403, { kind: "rejected", code: "AUTHENTICATION" }],
    [500, { kind: "unknown" }], [200, { kind: "unknown" }],
  ] as const) {
    const transport: typeof fetch = async () => new Response("{}", { status });
    assert.deepEqual(await new RecallProvider("test-key", "us-west-2", transport).create(input), expected);
  }
});
test("accepted provider ID is validated and payload preserves the meeting URL", async () => {
  const transport: typeof fetch = async (url, init) => {
    assert.equal(url, "https://us-west-2.recall.ai/api/v1/bot/");
    assert.equal(init?.redirect, "error");
    assert.equal(JSON.parse(String(init?.body)).meeting_url, input.meetingUrl);
    return Response.json({ id: attemptId });
  };
  assert.deepEqual(await new RecallProvider("test-key", "us-west-2", transport).create(input),
    { kind: "accepted", providerId: attemptId });
});
