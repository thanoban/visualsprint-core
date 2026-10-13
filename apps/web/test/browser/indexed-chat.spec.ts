import { test, expect, type Page } from "@playwright/test";
const projectId = "44444444-4444-4444-8444-444444444444",
  meetingId = "55555555-5555-4555-8555-555555555555",
  customerId = "77777777-7777-4777-8777-777777777777",
  threadId = "88888888-8888-4888-8888-888888888888",
  indexId = "99999999-9999-4999-8999-999999999999",
  answerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  segmentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
async function fixture(page: Page) {
  let indexes = 0,
    indexReads = 0,
    rejectIndexed = false;
  const modes: string[] = [],
    messages: Record<string, unknown>[] = [];
  const thread = {
    id: threadId,
    title: "Project history",
    scope: { kind: "project", id: projectId },
    version: 1,
  };
  await page.route("**/api/v3/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    expect(request.headers().authorization).toBe("Bearer controlled-indexed-chat-fixture");
    if (path.endsWith("/chats")) return route.fulfill({ json: [thread] });
    if (path.endsWith("/indexes") && request.method() === "POST") {
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      expect(request.postDataJSON()).toEqual({ scope: thread.scope });
      indexes++;
      return route.fulfill({
        status: 202,
        json: {
          id: indexId,
          scope: thread.scope,
          status: "queued",
          cursor: 0,
          totalChunks: 1,
          sourceFingerprint: "a".repeat(64),
          errorCode: null,
          createdAt: "2026-10-14T00:00:00Z",
        },
      });
    }
    if (path.endsWith("/indexes/" + indexId)) {
      indexReads++;
      return route.fulfill({
        json: {
          id: indexId,
          scope: thread.scope,
          status: indexReads > 1 ? "complete" : "queued",
          cursor: indexReads > 1 ? 1 : 0,
          totalChunks: 1,
          sourceFingerprint: "a".repeat(64),
          errorCode: null,
          createdAt: "2026-10-14T00:00:00Z",
        },
      });
    }
    if (path.endsWith(`/chats/${threadId}/messages`)) {
      if (request.method() === "GET") return route.fulfill({ json: { thread, messages } });
      const body = request.postDataJSON();
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      modes.push(body.retrievalMode ?? "lexical");
      if (rejectIndexed && body.retrievalMode === "indexed")
        return route.fulfill({ status: 409, json: { code: "INDEX_NOT_READY" } });
      if (body.retrievalMode === "indexed")
        expect(body).toEqual({ text: "What did we agree?", retrievalMode: "indexed" });
      else expect(body).toEqual({ text: "What did we agree?" });
      const answer = {
        id: answerId,
        kind: "answer",
        threadId,
        question: body.text,
        retrievalMode: body.retrievalMode ?? "lexical",
        status: "complete",
        result: {
          claims: [
            {
              kind: "decision",
              text: "We agreed to use the reviewed plan.",
              citation: { meetingId, captureId: indexId, segmentId, revision: 1 },
            },
          ],
          partial: true,
          unsupported: false,
          reviewRequired: true,
        },
        errorCode: null,
        createdAt: "2026-10-14T00:00:00Z",
      };
      messages.push(answer);
      return route.fulfill({ status: 202, json: answer });
    }
    throw new Error(`Unexpected API call ${request.method()} ${path}`);
  });
  return {
    indexes: () => indexes,
    modes,
    reject: () => {
      rejectIndexed = true;
    },
  };
}
async function choose(page: Page) {
  await page.getByRole("combobox", { name: "Saved chats" }).selectOption(threadId);
  await expect(page.getByRole("combobox", { name: "Answer retrieval" })).toHaveValue("lexical");
}
async function build(page: Page) {
  await page
    .getByRole("checkbox", {
      name: "I choose to build this scoped text index using the configured embedding provider.",
    })
    .check();
  await page.getByRole("button", { name: "Build scoped index", exact: true }).click();
  await expect(page.getByRole("article", { name: "Index progress" })).toContainText("complete");
}

test("indexed answer is an explicit persisted mode after ready index, with no automatic build or lexical fallback", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/indexed-chat.html");
  await choose(page);
  expect(f.indexes()).toBe(0);
  await page.getByRole("combobox", { name: "Answer retrieval" }).selectOption("indexed");
  await expect(page.getByRole("button", { name: "Ask", exact: true })).toBeDisabled();
  await page.getByRole("combobox", { name: "Answer retrieval" }).selectOption("lexical");
  await expect(page.getByLabel("Question", { exact: true })).toBeEnabled();
  await build(page);
  await page.getByRole("combobox", { name: "Answer retrieval" }).selectOption("indexed");
  await page.getByLabel("Question", { exact: true }).fill("What did we agree?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByRole("article", { name: "Saved chat answer" })).toContainText(
    "Retrieval: indexed",
  );
  expect(f.modes).toEqual(["indexed"]);
  expect(f.indexes()).toBe(1);
  await page.reload();
  await choose(page);
  await expect(page.getByRole("article", { name: "Saved chat answer" })).toContainText(
    "Retrieval: indexed",
  );
  expect(f.indexes()).toBe(1);
  await page.getByRole("combobox", { name: "Chat context" }).selectOption(`customer:${customerId}`);
  await expect(page.getByRole("article", { name: "Saved chat answer" })).toHaveCount(0);
  await expect(page.getByRole("article", { name: "Index progress" })).toHaveCount(0);
});
test("INDEX_NOT_READY keeps the explicit mode and question; lexical retry requires a new user choice", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/indexed-chat.html");
  await choose(page);
  await build(page);
  await page.getByRole("combobox", { name: "Answer retrieval" }).selectOption("indexed");
  await page.getByLabel("Question", { exact: true }).fill("What did we agree?");
  f.reject();
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByText(/no answer was switched to lexical retrieval/)).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Answer retrieval" })).toHaveValue("indexed");
  await expect(page.getByRole("textbox", { name: "Question", exact: true })).toHaveValue(
    "What did we agree?",
  );
  await expect(page.getByRole("button", { name: "Ask", exact: true })).toBeDisabled();
  expect(f.modes).toEqual(["indexed"]);
  await page.getByRole("combobox", { name: "Answer retrieval" }).selectOption("lexical");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByRole("article", { name: "Saved chat answer" })).toContainText(
    "Retrieval: lexical",
  );
  expect(f.modes).toEqual(["indexed", "lexical"]);
  expect(f.indexes()).toBe(1);
});
test("indexed UTF-8 query bound prevents a paid request for oversized multibyte input", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/indexed-chat.html");
  await choose(page);
  await build(page);
  await page.getByRole("combobox", { name: "Answer retrieval" }).selectOption("indexed");
  await page.getByLabel("Question", { exact: true }).fill("😀".repeat(1501));
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByText(/Indexed questions must fit within 6,000 UTF-8 bytes/)).toBeVisible();
  expect(f.modes).toEqual([]);
});
