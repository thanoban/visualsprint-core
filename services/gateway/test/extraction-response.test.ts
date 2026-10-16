import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { generateKeyPair } from "jose";
import { gatewayApp } from "../src/http/app.js";

test("only authorized extraction detail GET has a bounded aggregate response allowance", async () => {
  const workspaceId = randomUUID(),
    jobId = randomUUID(),
    userId = randomUUID();
  const keys = await generateKeyPair("EdDSA");
  let size = 1_200_000,
    allow = true;
  const app = gatewayApp(
    {
      accountUrl: "https://account.invalid",
      privateKey: keys.privateKey,
      keyId: "fixture",
      cells: {
        test: {
          intelligence: "https://intelligence.invalid",
          notification: "https://notification.invalid",
        },
      },
    },
    async () => ({ subject: "controlled-user", sessionId: "controlled-session" }),
    async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "account.invalid") {
        if (url.pathname === "/api/v3/me") return Response.json({ userId });
        return allow
          ? Response.json({ cellId: "test" })
          : Response.json({ code: "FORBIDDEN" }, { status: 403 });
      }
      return Response.json({ text: "x".repeat(size) });
    },
  );
  const path = `/api/v3/workspaces/${workspaceId}`;
  const request = (suffix: string, method: "GET" | "POST" = "GET") =>
    app.inject({
      method,
      url: `${path}/${suffix}`,
      headers: { authorization: "Bearer controlled-token" },
    });
  try {
    assert.equal((await request(`intelligence/capture-extractions/${jobId}`)).statusCode, 200);
    assert.equal(
      (await request(`intelligence/capture-extractions/${jobId}`, "POST")).statusCode,
      503,
    );
    assert.equal(
      (await request("intelligence/meetings/meeting/capture-extractions")).statusCode,
      503,
    );
    assert.equal((await request("realtime/negotiate", "POST")).statusCode, 503);
    size = 3_200_000;
    assert.equal((await request(`intelligence/capture-extractions/${jobId}`)).statusCode, 503);
    allow = false;
    assert.equal((await request(`intelligence/capture-extractions/${jobId}`)).statusCode, 403);
  } finally {
    await app.close();
  }
});
