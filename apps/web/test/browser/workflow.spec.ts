import { test, expect } from "@playwright/test";
const workspaceId = "11111111-1111-4111-8111-111111111111",
  ownerId = "33333333-3333-4333-8333-333333333333",
  meetingId = "55555555-5555-4555-8555-555555555555",
  actionId = "99999999-9999-4999-8999-999999999999",
  operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
test("meeting task requires exact approval before separate execution and shows ambiguous outcome honestly", async ({
  page,
}) => {
  const meeting = {
    id: meetingId,
    workspaceId,
    ownerId,
    title: "Customer review",
    notes: "",
    joinUrl: null,
    version: 1,
    blocked: false,
    createdAt: "2026-10-13T00:00:00Z",
  };
  let action = {
    id: actionId,
    workspaceId,
    ownerId,
    version: 1,
    state: "draft",
    approvalId: null as string | null,
    payloadHash: "a".repeat(64),
    input: {
      connectionId: "88888888-8888-4888-8888-888888888888",
      provider: "jira",
      destination: "CORE",
      payload: {
        title: "Implement reviewed feature",
        description: "<script>window.actionLeak=true</script>",
        dueDate: null,
      },
      source: { meetingId, revision: 1 },
    },
  };
  let creates = 0,
    approvals = 0;
  await page.route("**/api/v3/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    expect(request.headers().authorization).toBe("Bearer controlled-browser-fixture");
    if (path === "/api/v3/me")
      return route.fulfill({
        json: {
          userId: ownerId,
          workspaces: [{ id: workspaceId, name: "Founder workspace", cellId: "local" }],
        },
      });
    if (path.endsWith("/members"))
      return route.fulfill({
        json: [{ userId: ownerId, role: "owner", active: true, version: 1 }],
      });
    if (path.endsWith("/projects") || path.endsWith("/customers"))
      return route.fulfill({ json: [] });
    if (path.endsWith("/meetings")) return route.fulfill({ json: [meeting] });
    if (path.endsWith(`/meetings/${meetingId}`)) return route.fulfill({ json: meeting });
    if (path.endsWith("/captures")) return route.fulfill({ json: [] });
    if (path.endsWith("/actions")) return route.fulfill({ json: [action] });
    if (path.endsWith(`/actions/${actionId}/operations`))
      return route.fulfill({
        json: creates
          ? [
              {
                id: operationId,
                actionId,
                state: "unknown",
                externalId: null,
                errorCode: "EXECUTION_UNCONFIRMED",
                version: 2,
              },
            ]
          : [],
      });
    if (path.endsWith(`/actions/${actionId}/approve`)) {
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      expect(request.postDataJSON()).toEqual({ expectedVersion: 1, confirmed: true });
      approvals++;
      action = {
        ...action,
        state: "approved",
        version: 2,
        approvalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      };
      return route.fulfill({ json: action });
    }
    if (path.endsWith(`/actions/${actionId}/execute`)) {
      expect(approvals).toBe(1);
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      expect(request.postDataJSON()).toEqual({ expectedVersion: 2 });
      creates++;
      return route.fulfill({
        status: 202,
        json: {
          id: operationId,
          actionId,
          state: "unknown",
          externalId: null,
          errorCode: "EXECUTION_UNCONFIRMED",
          version: 2,
        },
      });
    }
    if (path.endsWith(`/operations/${operationId}`))
      return route.fulfill({
        json: {
          id: operationId,
          actionId,
          state: "unknown",
          externalId: null,
          errorCode: "EXECUTION_UNCONFIRMED",
          version: 2,
        },
      });
    return route.fulfill({ status: 404, json: { code: "NOT_FOUND" } });
  });
  await page.goto(`/w/${workspaceId}?meetingId=${meetingId}`);
  const panel = page.getByRole("region", { name: "Approved meeting actions" });
  await expect(panel).toBeVisible();
  const approve = panel.getByRole("button", { name: "Approve reviewed task", exact: true });
  await expect(approve).toBeDisabled();
  await expect(
    panel.getByRole("button", { name: "Queue external task creation", exact: true }),
  ).toHaveCount(0);
  await panel
    .getByRole("checkbox", { name: "I approve this exact destination and task text." })
    .check();
  await approve.click();
  await expect(
    panel.getByRole("button", { name: "Queue external task creation", exact: true }),
  ).toBeEnabled();
  expect(creates).toBe(0);
  await panel.getByRole("button", { name: "Queue external task creation", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText(
    "checking for the existing task before any retry",
  );
  await expect(
    panel.getByRole("button", { name: "Queue external task creation", exact: true }),
  ).toBeDisabled();
  expect(creates).toBe(1);
  expect(
    await page.evaluate(() => Boolean((window as unknown as { actionLeak?: boolean }).actionLeak)),
  ).toBe(false);
});
