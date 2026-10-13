import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HttpActionProvider } from "../src/infrastructure/action-provider.js";
import {
  actionFingerprint,
  type ActionConnection,
  type ExecutionIntent,
} from "../src/application/action-executions.js";
function intent(c: ActionConnection): ExecutionIntent {
  const draft = {
    connectionId: c.id,
    provider: c.provider,
    destination: c.destination,
    payload: { title: "Exact task", description: "Exact body\nsecond line", dueDate: null },
    source: { meetingId: randomUUID(), revision: 1 },
  };
  return {
    operationId: randomUUID(),
    approvalId: randomUUID(),
    payloadHash: actionFingerprint(draft),
    ...draft,
  };
}
const base = {
  workspaceId: randomUUID(),
  id: randomUUID(),
  ownerId: randomUUID(),
  credentialCipher: "encrypted",
  status: "configured" as const,
  version: 1,
};
test("vendor creates preserve reviewed payload and pin origin/credentials/redirect behavior", async () => {
  const teamId = randomUUID();
  for (const c of [
    {
      ...base,
      provider: "github" as const,
      destination: "example/repo",
      configuration: { provider: "github", repository: "example/repo" },
    },
    {
      ...base,
      provider: "jira" as const,
      destination: "CORE",
      configuration: {
        provider: "jira",
        cloudId: randomUUID(),
        projectKey: "CORE",
        issueTypeId: "10001",
      },
    },
    {
      ...base,
      provider: "linear" as const,
      destination: teamId,
      configuration: { provider: "linear", teamId, authMode: "api_key" },
    },
  ] as ActionConnection[]) {
    let calls = 0;
    const p = new HttpActionProvider(async (url, init) => {
      calls++;
      const u = new URL(String(url));
      assert.equal(u.protocol, "https:");
      assert.ok(["api.github.com", "api.atlassian.com", "api.linear.app"].includes(u.hostname));
      assert.equal(init?.redirect, "error");
      const body = JSON.parse(String(init?.body));
      if (c.provider === "github") {
        assert.deepEqual(body, { title: "Exact task", body: "Exact body\nsecond line" });
        return Response.json({ number: 42 }, { status: 201 });
      }
      if (c.provider === "jira") {
        assert.equal(body.fields.summary, "Exact task");
        assert.equal(body.fields.description.content[1].content[0].text, "second line");
        return Response.json({ id: "10000", key: "CORE-1" }, { status: 201 });
      }
      assert.equal((init?.headers as Record<string, string>).authorization, "private-token");
      assert.equal(body.variables.input.title, "Exact task");
      return Response.json({
        data: { issueCreate: { success: true, issue: { id: randomUUID() } } },
      });
    });
    assert.equal((await p.create(c, "private-token", intent(c))).state, "confirmed");
    assert.equal(calls, 1);
  }
});
test("transport/partial/malformed create remains unknown; unsupported due date makes no writes", async () => {
  const c: ActionConnection = {
    ...base,
    provider: "github",
    destination: "example/repo",
    configuration: { provider: "github", repository: "example/repo" },
  };
  for (const transport of [
    async () => {
      throw new Error("private provider details");
    },
    async () => Response.json({ wrong: "body" }, { status: 201 }),
    async () => new Response("", { status: 503 }),
  ] as (typeof fetch)[])
    assert.deepEqual(
      await new HttpActionProvider(transport).create(c, "private-token", intent(c)),
      { state: "unknown" },
    );
  let calls = 0;
  const p = new HttpActionProvider(async () => {
      calls++;
      return Response.json({});
    }),
    input = intent(c);
  input.payload.dueDate = "2026-10-20";
  assert.deepEqual(await p.create(c, "private-token", input), {
    state: "rejected",
    code: "UNSUPPORTED_DUE_DATE",
  });
  assert.equal(calls, 0);
});
test("read reference requires exact approved body and never treats absence as not-created", async () => {
  const c: ActionConnection = {
    ...base,
    provider: "github",
    destination: "example/repo",
    configuration: { provider: "github", repository: "example/repo" },
  };
  const p = new HttpActionProvider(async (url, init) => {
    assert.equal(String(url), "https://api.github.com/repos/example/repo/issues/42");
    assert.equal(init?.method, "GET");
    return Response.json({
      number: 42,
      title: "Exact task",
      body: "changed",
      state: "open",
      updated_at: "2026-10-13T00:00:00Z",
    });
  });
  assert.equal(await p.verify(c, "private-token", intent(c), "42"), false);
  await assert.rejects(
    new HttpActionProvider(async () => new Response("", { status: 404 })).verify(
      c,
      "private-token",
      intent(c),
      "42",
    ),
  );
});
