import test from "node:test";
import assert from "node:assert/strict";
import { NotificationService } from "../src/application/notification.js";
test("email first-party origin rejects credentials, redirects-as-query and unsupported schemes even for local hosts", () => {
  for (const origin of [
    "ftp://localhost",
    "http://external.example",
    "https://user:password@app.example",
    "https://app.example/?next=https://external.example",
    "https://app.example/nested",
    "https://app.example/#fragment",
  ])
    assert.throws(
      () => new NotificationService(null as never, null as never, null as never, origin),
      /INVALID_APP_ORIGIN/,
    );
  assert.doesNotThrow(
    () =>
      new NotificationService(null as never, null as never, null as never, "https://app.example"),
  );
});
