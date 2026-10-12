import test from "node:test";
import assert from "node:assert/strict";
import {routeService} from "../src/application/routing.js";
test("capture routes never become Workspace commands and unknown routes cannot select origins",()=>{
  assert.equal(routeService("meetings/meeting-id/captures"),"ingest");
  assert.equal(routeService("meetings/meeting-id/assignments"),"workspace");
  assert.equal(routeService("chats/thread-id/messages"),"intelligence");
  assert.equal(routeService("https://evil.example.com"),undefined);
});
