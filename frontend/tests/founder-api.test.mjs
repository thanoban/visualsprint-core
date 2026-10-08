import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, apiJson, captureFingerprint, founderApi, workspacePath } from "../lib/founder-api.ts";

test("workspace requests encode identifiers and never accept an external origin", () => {
  assert.equal(workspacePath("org/other", "/projects"), "/api/v2/workspaces/org%2Fother/projects");
  assert.throws(() => workspacePath("org", "https://other.example.com"));
  assert.throws(() => workspacePath("org", "//other.example.com"));
  assert.equal(workspacePath("org", ""), "/api/v2/workspaces/org");
});
test("assignment sends the version the user saw and only the selected project", async () => {
  const requests = [];
  const api = founderApi(async (path, init) => {
    requests.push({ path, init }); return Response.json({ version: 3 });
  }, "workspace");
  await api.assignMeeting({ id: "meeting", assignment_version: 2 }, "project");
  assert.equal(requests[0].path, "/api/v2/workspaces/workspace/meetings/meeting/assignment");
  assert.deepEqual(JSON.parse(requests[0].init.body), { project_id: "project", version: 2 });
});
test("a conflict is visible and never automatically retries sharing", async () => {
  let count = 0;
  const api = founderApi(async () => { count++; return Response.json({ detail: "assignment changed" }, { status: 409 }); }, "workspace");
  await assert.rejects(api.assignMeeting({ id: "m", assignment_version: 1 }, "p"), (error) => error instanceof ApiError && error.status === 409);
  assert.equal(count, 1);
});
test("unassignment is versioned and handles a 204 without parsing JSON", async () => {
  let actual;
  const api = founderApi(async (path, init) => { actual = { path, init }; return new Response(null, { status: 204 }); }, "workspace");
  assert.equal(await api.unassignMeeting({ id: "meeting", assignment_version: 4 }), undefined);
  assert.equal(actual.path, "/api/v2/workspaces/workspace/meetings/meeting/assignment?version=4");
  assert.equal(actual.init.method, "DELETE");
});
test("project creation is private by server default and does not grant participant memberships", async () => {
  let body;
  const api = founderApi(async (_path, init) => { body = JSON.parse(init.body); return Response.json({ id: "project" }); }, "workspace");
  await api.createProject("Renewal", "customer");
  assert.deepEqual(body, { name: "Renewal", customer_id: "customer" });
});
test("non-JSON permission errors preserve status", async () => {
  await assert.rejects(apiJson(async () => new Response("Forbidden", { status: 403 }), "/api/path"), (error) => error instanceof ApiError && error.status === 403);
});

test("ad-hoc capture is independent of a calendar and preserves the caller's retry key", async () => {
  const requests = [];
  const api = founderApi(async (path, init) => {
    requests.push({ path, init }); return Response.json({ id: "request", meeting_id: "meeting", status: "queued" });
  }, "workspace");
  const input = { meeting_url: " https://meet.google.com/abc-defg-hij ", title: " Customer call ", project_id: null };
  await api.startCapture(input, "retry-key");
  await api.startCapture(input, "retry-key");
  assert.equal(requests.length, 2);
  for (const { path, init } of requests) {
    assert.equal(path, "/api/v2/workspaces/workspace/captures");
    assert.equal(init.headers["Idempotency-Key"], "retry-key");
    assert.deepEqual(JSON.parse(init.body), { meeting_url: "https://meet.google.com/abc-defg-hij", title: "Customer call", project_id: null });
  }
});

test("capture intent identity includes title and sharing destination, not just URL", () => {
  const input = { meeting_url: "https://meet.google.com/abc-defg-hij", title: "Call", project_id: null };
  assert.equal(captureFingerprint(input), captureFingerprint({ ...input, title: " Call " }));
  assert.notEqual(captureFingerprint(input), captureFingerprint({ ...input, title: "Other" }));
  assert.notEqual(captureFingerprint(input), captureFingerprint({ ...input, project_id: "shared-project" }));
});

test("capture status and stop use durable IDs and support abortable polling", async () => {
  const calls = [];
  const api = founderApi(async (path, init) => { calls.push({ path, init }); return Response.json({ id: "request" }); }, "workspace");
  const controller = new AbortController();
  await api.captureStatus("request/id", controller.signal);
  await api.stopCapture("request/id");
  assert.equal(calls[0].path, "/api/v2/workspaces/workspace/capture-requests/request%2Fid");
  assert.equal(calls[0].init.signal, controller.signal);
  assert.equal(calls[1].path, "/api/v2/workspaces/workspace/capture-requests/request%2Fid/stop");
  assert.equal(calls[1].init.method, "POST");
});
