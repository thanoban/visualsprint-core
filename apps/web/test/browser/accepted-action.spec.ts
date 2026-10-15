import { test, expect, type Page } from "@playwright/test";
const workspaceId = "11111111-1111-4111-8111-111111111111",
  meetingId = "55555555-5555-4555-8555-555555555555",
  commitmentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  connectionId = "88888888-8888-4888-8888-888888888888",
  actionId = "99999999-9999-4999-8999-999999999999",
  operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
async function fixture(page: Page) {
  let sourceVersion = 1,
    sourceState = "open",
    evidenceStatus = "current",
    denied = false,
    operationState = "unknown",
    drafts = 0,
    approvals = 0,
    executions = 0,
    statusChecks = 0;
  const source = () => ({
    id: commitmentId,
    meetingId,
    kind: "commitment",
    title: "Send customer offer",
    text: "<script>window.taskLeak=true</script>",
    dueDate: "2026-10-20",
    state: sourceState,
    version: sourceVersion,
    humanReviewed: true,
    evidenceStatus,
    sourcePartial: true,
  });
  let action: Record<string, unknown> | null = null;
  const operation = () => ({
    id: operationId,
    actionId,
    state: operationState,
    externalId: operationState === "confirmed" ? "CORE-42" : null,
    errorCode: null,
    version: operationState === "confirmed" ? 3 : 2,
  });
  await page.route("**/api/v3/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    expect(request.headers().authorization).toBe("Bearer controlled-accepted-action");
    if (
      denied ||
      path.includes("66666666-6666-4666-8666-666666666666") ||
      url.searchParams.get("meetingId") === "66666666-6666-4666-8666-666666666666" ||
      url.searchParams.get("scopeId") === "66666666-6666-4666-8666-666666666666"
    )
      return route.fulfill({ status: 403, json: { code: "FORBIDDEN" } });
    if (path.endsWith("/action-connections"))
      return route.fulfill({
        json: [
          {
            id: connectionId,
            provider: "jira",
            destination: "CORE",
            status: "configured",
            version: 1,
          },
        ],
      });
    if (path.endsWith("/commitments")) return route.fulfill({ json: [source()] });
    if (path.endsWith(`/commitments/${commitmentId}`)) return route.fulfill({ json: source() });
    if (path.endsWith("/actions")) {
      if (request.method() === "GET") return route.fulfill({ json: action ? [action] : [] });
      const body = request.postDataJSON();
      expect(body.source).toEqual({
        meetingId,
        revision: 1,
        commitment: { id: commitmentId, version: 1 },
      });
      expect(body).toMatchObject({
        provider: "jira",
        destination: "CORE",
        connectionId,
        payload: {
          title: "Send customer offer",
          description: "<script>window.taskLeak=true</script>",
          dueDate: "2026-10-20",
        },
      });
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      drafts++;
      action = {
        id: actionId,
        workspaceId,
        ownerId: "33333333-3333-4333-8333-333333333333",
        state: "draft",
        version: 1,
        input: body,
        payloadHash: "a".repeat(64),
        approvalId: null,
      };
      return route.fulfill({ status: 201, json: action });
    }
    if (path.endsWith("/operations") && request.method() === "GET")
      return route.fulfill({ json: executions ? [operation()] : [] });
    if (path.endsWith("/approve")) {
      expect(request.postDataJSON()).toEqual({ expectedVersion: 1, confirmed: true });
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      approvals++;
      action = {
        ...action!,
        state: "approved",
        version: 2,
        approvalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      };
      return route.fulfill({ json: action });
    }
    if (path.endsWith("/execute")) {
      expect(approvals).toBe(1);
      expect(request.postDataJSON()).toEqual({ expectedVersion: 2 });
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      executions++;
      return route.fulfill({ status: 202, json: operation() });
    }
    if (path.endsWith(`/operations/${operationId}`)) return route.fulfill({ json: operation() });
    if (path.endsWith("/task-status")) {
      statusChecks++;
      return route.fulfill({
        json: {
          operationId,
          externalId: "CORE-42",
          state: "done",
          status: "Done",
          updatedAt: "2026-10-14T10:00:00Z",
        },
      });
    }
    throw new Error(`Unexpected operation ${request.method()} ${path}`);
  });
  return {
    counts: () => ({ drafts, approvals, executions, statusChecks }),
    revise: () => sourceVersion++,
    close: () => (sourceState = "completed"),
    changed: () => (evidenceStatus = "changed"),
    deny: () => (denied = true),
    confirm: () => (operationState = "confirmed"),
  };
}
async function draft(page: Page) {
  await page.goto("/accepted-action.html");
  const panel = page.getByRole("region", { name: "Draft task from reviewed commitment" });
  await panel.getByLabel("Accepted commitment").selectOption(commitmentId);
  await panel.getByLabel("Configured task connector").selectOption(connectionId);
  return panel;
}
test("accepted source creates only a linked draft, then exact approval and execution remain separate; task completion is provider snapshot only", async ({
  page,
}) => {
  const f = await fixture(page),
    panel = await draft(page);
  await expect(panel.getByLabel("Linked due date (optional)")).toHaveValue("2026-10-20");
  await panel.getByRole("button", { name: "Save linked draft (does not execute)" }).click();
  const approval = page.getByRole("button", { name: "Approve reviewed task" });
  await expect(approval).toBeDisabled();
  expect(f.counts()).toEqual({ drafts: 1, approvals: 0, executions: 0, statusChecks: 0 });
  await expect(page.getByText("Exact due date: 2026-10-20.")).toBeVisible();
  await page
    .getByRole("checkbox", { name: "I approve this exact destination and task text." })
    .check();
  await approval.click();
  expect(f.counts().executions).toBe(0);
  await page.getByRole("button", { name: "Queue external task creation" }).click();
  await expect(page.getByText(/checking for the existing task before any retry/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Queue external task creation" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Check external task status" })).toHaveCount(0);
  expect(f.counts().executions).toBe(1);
  f.confirm();
  await expect(page.getByRole("button", { name: "Check external task status" })).toBeVisible({
    timeout: 10000,
  });
  expect(f.counts().statusChecks).toBe(0);
  await page.getByRole("button", { name: "Check external task status" }).click();
  await expect(page.getByRole("region", { name: "External task status" })).toContainText(
    "Done · provider state done",
  );
  await expect(page.getByRole("region", { name: "External task status" })).toContainText(
    "does not mark the human commitment completed",
  );
  expect(f.counts()).toEqual({ drafts: 1, approvals: 1, executions: 1, statusChecks: 1 });
  expect(
    await page.evaluate(() => Boolean((window as unknown as { taskLeak?: boolean }).taskLeak)),
  ).toBe(false);
  f.deny();
  await page.getByRole("button", { name: "Refresh reviewed actions" }).click();
  await expect(page.getByRole("region", { name: "External task status" })).toHaveCount(0);
  await expect(page.getByLabel("Linked exact description")).toHaveCount(0);
});
test("changed accepted version is rejected before draft save; unavailable evidence never grants write readiness", async ({
  page,
}) => {
  const f = await fixture(page),
    panel = await draft(page);
  f.revise();
  await panel.getByRole("button", { name: "Save linked draft (does not execute)" }).click();
  await expect(panel.getByRole("alert")).toContainText("changed while you were editing");
  expect(f.counts().drafts).toBe(0);
  f.changed();
  await panel.getByRole("button", { name: "Refresh accepted sources and connectors" }).click();
  await expect(panel.getByLabel("Accepted commitment")).toHaveValue("");
  await expect(panel.getByRole("option", { name: /evidence changed/ })).toHaveAttribute(
    "disabled",
    "",
  );
});
test("linked approval source change blocks execution and shared readers have no mutation surface", async ({
  page,
}) => {
  const f = await fixture(page),
    panel = await draft(page);
  await panel.getByRole("button", { name: "Save linked draft (does not execute)" }).click();
  f.close();
  await expect(page.getByRole("button", { name: "Approve reviewed task" })).toBeDisabled();
  await expect(
    page.getByText(/accepted source is loading, unavailable, changed or no longer open/),
  ).toBeVisible({ timeout: 10000 });
  expect(f.counts().approvals).toBe(0);
  await page.goto("/accepted-action.html?reader=1");
  await expect(page.getByRole("region", { name: "Approved meeting actions" })).toHaveCount(0);
});
