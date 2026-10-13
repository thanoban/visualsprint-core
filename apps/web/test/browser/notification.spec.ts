import { test, expect } from "@playwright/test";
const workspaceId = "11111111-1111-4111-8111-111111111111",
  ownerId = "33333333-3333-4333-8333-333333333333",
  meetingId = "55555555-5555-4555-8555-555555555555",
  notificationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
test("notification preferences require verified-email consent and in-app updates expose only authorized first-party references", async ({
  page,
}) => {
  let settings = {
    workspaceId,
    userId: ownerId,
    version: 0,
    inApp: false,
    email: false,
    deliveryHourUtc: null as number | null,
  };
  let item = {
    id: notificationId,
    meetingId,
    kind: "summary_ready",
    channel: "in_app",
    state: "delivered",
    version: 3,
    availableAt: "2026-10-13T00:00:00Z",
    readAt: null as string | null,
    errorCode: null,
  };
  let writes = 0;
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
    if (path.endsWith("/customers") || path.endsWith("/projects") || path.endsWith("/meetings"))
      return route.fulfill({ json: [] });
    if (path.endsWith("/notification-preferences")) {
      if (request.method() === "POST") {
        expect(request.headers()["idempotency-key"]).toBeTruthy();
        expect(request.postDataJSON()).toEqual({
          expectedVersion: 0,
          inApp: true,
          email: true,
          deliveryHourUtc: 8,
          emailConsent: true,
        });
        settings = { ...settings, version: 1, inApp: true, email: true, deliveryHourUtc: 8 };
        writes++;
      }
      return route.fulfill({ json: settings });
    }
    if (path.endsWith("/notifications"))
      return route.fulfill({ json: { items: [item], nextCursor: null } });
    if (path.endsWith(`/notifications/${notificationId}/read`)) {
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      expect(request.postDataJSON()).toEqual({ expectedVersion: 3 });
      item = { ...item, version: 4, readAt: "2026-10-13T01:00:00Z" };
      return route.fulfill({ json: item });
    }
    return route.fulfill({ status: 404, json: { code: "NOT_FOUND" } });
  });
  await page.goto(`/w/${workspaceId}`);
  await page.getByRole("button", { name: "Notifications", exact: true }).click();
  const panel = page.getByRole("region", { name: "Workspace notifications" });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Saving a preference does not prove email delivery");
  await expect(
    panel.getByRole("link", { name: "Open authorized meeting", exact: true }),
  ).toHaveAttribute("href", `/w/${workspaceId}?meetingId=${meetingId}`);
  await panel.getByRole("button", { name: "Mark read", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Mark read", exact: true })).toHaveCount(0);
  await panel.getByRole("checkbox", { name: "Enable in-app updates", exact: true }).check();
  await panel.getByRole("checkbox", { name: "Enable generic email updates", exact: true }).check();
  await panel
    .getByRole("combobox", { name: "Email delivery time (UTC)", exact: true })
    .selectOption("8");
  await panel.getByRole("button", { name: "Save notification preferences", exact: true }).click();
  expect(writes).toBe(0);
  await panel
    .getByRole("checkbox", {
      name: "I consent to generic updates sent only to my verified account email.",
      exact: true,
    })
    .check();
  await panel.getByRole("button", { name: "Save notification preferences", exact: true }).click();
  await expect(
    panel.getByRole("checkbox", { name: "Enable generic email updates", exact: true }),
  ).toBeChecked();
  await expect.poll(() => writes).toBe(1);
});
