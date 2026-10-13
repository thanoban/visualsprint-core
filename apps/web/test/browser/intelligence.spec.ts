import { test, expect, type Page } from "@playwright/test";

const workspaceId = "11111111-1111-4111-8111-111111111111",
  ownerId = "33333333-3333-4333-8333-333333333333",
  meetingId = "55555555-5555-4555-8555-555555555555",
  projectId = "66666666-6666-4666-8666-666666666666",
  customerId = "77777777-7777-4777-8777-777777777777",
  threadId = "88888888-8888-4888-8888-888888888888",
  jobId = "99999999-9999-4999-8999-999999999999",
  segmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const meeting = {
  id: meetingId,
  workspaceId,
  ownerId,
  title: "Acme renewal",
  notes: "",
  joinUrl: null,
  version: 1,
  blocked: false,
  createdAt: "2026-10-13T00:00:00Z",
};
async function fixture(page: Page) {
  let thread:
    | { id: string; title: string; scope: { kind: string; id: string | null }; version: number }
    | undefined;
  let answer: Record<string, unknown> | undefined,
    summary: Record<string, unknown> | undefined,
    revoked = false;
  const result = {
    claims: [
      {
        kind: "commitment",
        text: "<script>window.chatLeak = true</script>",
        citation: { meetingId, captureId: jobId, segmentId, revision: 2 },
      },
    ],
    partial: true,
    unsupported: false,
    reviewRequired: true,
  };
  await page.route("**/api/v3/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    expect(request.headers().authorization).toBe("Bearer controlled-browser-fixture");
    if (path === "/api/v3/me")
      return route.fulfill({
        json: {
          userId: ownerId,
          workspaces: [{ id: workspaceId, name: "Founder team", cellId: "dev-cell" }],
        },
      });
    if (path.endsWith("/intelligence/chats")) {
      if (request.method() === "GET") return route.fulfill({ json: thread ? [thread] : [] });
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      thread = { id: threadId, ...request.postDataJSON(), version: 1 };
      return route.fulfill({ status: 201, json: thread });
    }
    if (path.endsWith(`/intelligence/chats/${threadId}/messages`)) {
      if (request.method() === "GET")
        return revoked
          ? route.fulfill({ status: 403, json: { code: "SOURCE_FORBIDDEN" } })
          : route.fulfill({ json: { thread, messages: answer ? [answer] : [] } });
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      answer = {
        id: jobId,
        kind: "answer",
        threadId,
        question: request.postDataJSON().text,
        status: "complete",
        result,
        errorCode: null,
        createdAt: "2026-10-13T00:00:00Z",
      };
      return route.fulfill({ status: 202, json: answer });
    }
    if (path.endsWith("/intelligence/summaries")) {
      expect(request.postDataJSON()).toEqual({ meetingId });
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      summary = {
        id: jobId,
        kind: "summary",
        threadId: null,
        question: null,
        status: "complete",
        result,
        errorCode: null,
        createdAt: "2026-10-13T00:00:00Z",
      };
      return route.fulfill({ status: 202, json: { ...summary, status: "queued", result: null } });
    }
    if (path.endsWith(`/intelligence/meetings/${meetingId}/summaries`))
      return route.fulfill({ json: summary ? [summary] : [] });
    if (path.endsWith(`/meetings/${meetingId}/captures`)) return route.fulfill({ json: [] });
    if (path.endsWith("/customers"))
      return route.fulfill({
        json: [{ id: customerId, workspaceId, ownerId, name: "Acme", version: 1 }],
      });
    if (path.endsWith("/projects"))
      return route.fulfill({
        json: [{ id: projectId, workspaceId, ownerId, name: "Renewals", customerId, version: 1 }],
      });
    if (path.endsWith("/meetings")) return route.fulfill({ json: [meeting] });
    if (path.endsWith(`/meetings/${meetingId}`)) return route.fulfill({ json: meeting });
    if (path.endsWith("/members")) return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { code: "NOT_FOUND" } });
  });
  return {
    revoke() {
      revoked = true;
    },
    get thread() {
      return thread;
    },
  };
}
test("saved project chats preserve context, safely render evidence and clear revoked answers", async ({
  page,
}) => {
  const control = await fixture(page);
  await page.goto(`/w/${workspaceId}?projectId=${projectId}`);
  const create = page.getByRole("heading", { name: "New project chat" }).locator("..");
  await create.getByRole("textbox", { name: "Chat title" }).fill("Renewal context");
  await create.getByRole("button", { name: "Create chat", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Saved chats" })).toHaveValue(threadId);
  expect(control.thread!.scope).toEqual({ kind: "project", id: projectId });
  await page.getByRole("textbox", { name: "Question", exact: true }).fill("What did we commit?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByRole("article", { name: "Saved chat answer" })).toContainText(
    "Partial evidence",
  );
  await expect(page.getByRole("article", { name: "Saved chat answer" })).toContainText(
    "window.chatLeak = true",
  );
  expect(
    await page.evaluate(() => (window as unknown as Record<string, unknown>).chatLeak),
  ).toBeUndefined();
  await page.reload();
  await page.getByRole("combobox", { name: "Saved chats" }).selectOption(threadId);
  await expect(page.getByRole("article", { name: "Saved chat answer" })).toContainText(
    "What did we commit?",
  );
  control.revoke();
  await page.getByRole("button", { name: "Refresh intelligence" }).click();
  await expect(page.getByRole("article", { name: "Saved chat answer" })).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("no longer available");
});
test("meeting summaries expose partial evidence and customer contexts remain separate", async ({
  page,
}) => {
  await fixture(page);
  await page.goto(`/w/${workspaceId}?meetingId=${meetingId}`);
  await page.getByRole("button", { name: "Generate summary", exact: true }).click();
  const summary = page.getByRole("article", { name: "Meeting summary" });
  await expect(summary).toContainText("Partial evidence");
  await expect(summary).toContainText("proposals that require review");
  await expect(summary.getByRole("link", { name: "Open source meeting" })).toHaveAttribute(
    "href",
    `/w/${workspaceId}?meetingId=${meetingId}`,
  );
  await page.getByRole("combobox", { name: "Chat context" }).selectOption(`customer:${customerId}`);
  await expect(page.getByRole("heading", { name: "New customer chat" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Saved chats" }).first()).toHaveValue("");
});
