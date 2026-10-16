import test from "node:test";
import assert from "node:assert/strict";
import { routeService } from "../src/application/routing.js";
test("capture routes never become Workspace commands and unknown routes cannot select origins", () => {
  assert.equal(routeService("meetings/meeting-id/captures"), "ingest");
  assert.equal(routeService("captures/capture-id/processing-consent"), "ingest");
  assert.equal(routeService("captures/capture-id/processing-consent/withdraw"), "ingest");
  assert.equal(
    routeService("internal/workspaces/workspace-id/captures/capture-id/processing-evidence"),
    undefined,
  );
  assert.equal(routeService("capture-processing/authorize"), undefined);
  assert.equal(routeService("meetings/meeting-id/assignments"), "workspace");
  assert.equal(routeService("chats/thread-id/messages"), "intelligence");
  assert.equal(routeService("intelligence/preparations/job-id"), "intelligence");
  assert.equal(routeService("commitments/commitment-id"), "workspace");
  assert.equal(routeService("operations/operation-id"), "workflow");
  assert.equal(routeService("realtime/negotiate"), "notification");
  assert.equal(routeService("realtime/publish"), undefined);
  assert.equal(routeService("realtime/negotiate/other"), undefined);
  assert.equal(routeService("https://evil.example.com"), undefined);
});
