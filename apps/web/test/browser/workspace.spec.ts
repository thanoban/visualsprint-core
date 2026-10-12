import { test, expect, type Page } from "@playwright/test";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const ownerId = "33333333-3333-4333-8333-333333333333";
const memberId = "44444444-4444-4444-8444-444444444444";
const meetingId = "55555555-5555-4555-8555-555555555555";
const projectId = "66666666-6666-4666-8666-666666666666";
const customerId = "77777777-7777-4777-8777-777777777777";
const meeting = {
  id: meetingId,
  workspaceId,
  ownerId,
  title: "Acme renewal",
  notes: "<script>window.compromised = true</script>",
  joinUrl: null,
  version: 1,
  blocked: false,
  createdAt: "2026-10-12T00:00:00Z",
};
async function fixture(page: Page, captureEnabled = false) {
  let version = 1;
  const displayed = {
    ...meeting,
    joinUrl: captureEnabled ? "https://meet.google.com/abc-defg-hij" : null,
  };
  const captureId = "88888888-8888-4888-8888-888888888888";
  let currentCapture:
    | {
        id: string;
        state: string;
        ready: boolean;
        coverage: string;
        transcriptHealth: string;
        errorCode: string | null;
        version: number;
        stopRequested: boolean;
      }
    | undefined;
  const writes: { path: string; body: Record<string, unknown>; key: string | undefined }[] = [];
  await page.route("**/api/v3/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    expect(request.headers().authorization).toBe("Bearer controlled-browser-fixture");
    const path = url.pathname;
    if (path.endsWith(`/meetings/${meetingId}/captures`) && request.method() === "GET")
      return route.fulfill({ json: currentCapture ? [currentCapture] : [] });
    if (path.endsWith(`/captures/${captureId}/transcript`))
      return route.fulfill({
        json: {
          totalSegments: 1,
          segments: [
            {
              id: "segment-1",
              text: "<script>window.captureLeak = true</script>",
              speakerLabel: "Founder",
              startMs: 0,
            },
          ],
        },
      });
    if (path.endsWith("/captures") && request.method() === "POST") {
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      expect(request.postDataJSON()).toEqual({ meetingId, expectedMeetingVersion: version });
      currentCapture = {
        id: captureId,
        state: "waiting_for_admission",
        ready: true,
        coverage: "unknown",
        transcriptHealth: "unknown",
        errorCode: null,
        version: 1,
        stopRequested: false,
      };
      return route.fulfill({ status: 202, json: currentCapture });
    }
    if (path.endsWith(`/captures/${captureId}/stop`)) {
      currentCapture = { ...currentCapture!, state: "stopping", stopRequested: true, version: 2 };
      return route.fulfill({ json: currentCapture });
    }
    if (path === "/api/v3/me")
      return route.fulfill({
        json: {
          userId: ownerId,
          workspaces: [
            { id: workspaceId, name: "Founder team", cellId: "dev-cell" },
            { id: otherId, name: "Second workspace", cellId: "dev-cell" },
          ],
        },
      });
    if (request.method() !== "GET") {
      writes.push({
        path,
        body: request.postDataJSON() as Record<string, unknown>,
        key: request.headers()["idempotency-key"],
      });
      if (path.endsWith("/shares") || path.endsWith("/assignments") || path.endsWith(meetingId))
        return route.fulfill({ json: { ...displayed, version: ++version } });
    }
    if (path.endsWith("/customers"))
      return route.fulfill({
        json: path.includes(otherId)
          ? []
          : [{ id: customerId, workspaceId, ownerId, name: "Acme", version: 1 }],
      });
    if (path.endsWith("/projects"))
      return route.fulfill({
        json: path.includes(otherId)
          ? []
          : [{ id: projectId, workspaceId, ownerId, name: "Renewals", customerId, version: 1 }],
      });
    if (path.endsWith("/meetings"))
      return route.fulfill({ json: path.includes(otherId) ? [] : [{ ...displayed, version }] });
    if (path.endsWith(meetingId)) return route.fulfill({ json: { ...displayed, version } });
    if (path.endsWith("/members"))
      return route.fulfill({
        json: [{ userId: memberId, role: "member", active: true, version: 1 }],
      });
    return route.fulfill({ status: 404, json: { code: "NOT_FOUND" } });
  });
  return writes;
}
test("project context, notes, assignment and explicit sharing are separate browser flows", async ({
  page,
}) => {
  const writes = await fixture(page);
  await page.goto(`/w/${workspaceId}`);
  await expect(page.getByRole("heading", { name: "Founder team" })).toBeVisible();
  await page.getByRole("link", { name: "Renewals Acme" }).click();
  await expect(page).toHaveURL(new RegExp(`projectId=${projectId}`));
  await page.getByRole("link", { name: /Acme renewal/ }).click();
  await expect(page.getByRole("textbox", { name: "Notes", exact: true })).toHaveValue(
    meeting.notes,
  );
  expect(
    await page.evaluate(() => (window as unknown as Record<string, unknown>).compromised),
  ).toBeUndefined();
  await page.getByRole("combobox", { name: "Project", exact: true }).selectOption(projectId);
  await page.getByRole("button", { name: "Confirm assignment" }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]?.body).toEqual({ projectId, confirmed: true, expectedVersion: 1 });
  await expect(page.getByRole("combobox", { name: "Workspace member", exact: true })).toBeVisible();
  await page
    .getByRole("combobox", { name: "Workspace member", exact: true })
    .selectOption(memberId);
  await page.getByRole("button", { name: "Grant access" }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]?.body).toEqual({ userId: memberId, expectedVersion: 2 });
  expect(writes.every((write) => Boolean(write.key))).toBe(true);
});
test("capture UI distinguishes admission, transcript coverage and unconfirmed stop", async ({
  page,
}) => {
  await fixture(page, true);
  await page.goto(`/w/${workspaceId}?meetingId=${meetingId}`);
  await page.getByRole("button", { name: "Start capture", exact: true }).click();
  const panel = page.getByRole("region", { name: "Meeting capture" });
  await expect(panel.getByRole("status")).toContainText("waiting for admission");
  await expect(panel.getByRole("status")).toContainText("coverage: unknown");
  await expect(panel).toContainText("<script>window.captureLeak = true</script>");
  expect(
    await page.evaluate(() => (window as unknown as Record<string, unknown>).captureLeak),
  ).toBeUndefined();
  await page.getByRole("button", { name: "Stop capture", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("stopping");
  await expect(panel.getByRole("status")).not.toContainText("complete");
});
test("switching workspaces clears previous project and meeting context", async ({ page }) => {
  await fixture(page);
  await page.goto(`/w/${workspaceId}?meetingId=${meetingId}`);
  await expect(page.getByRole("heading", { name: "Acme renewal" })).toBeVisible();
  await page.getByRole("link", { name: "Second workspace" }).click();
  await expect(page.getByRole("heading", { name: "Second workspace" })).toBeVisible();
  await expect(page.getByText("Acme renewal")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "No meetings here yet" })).toBeVisible();
});
test("backend outages keep the session and clear inaccessible data", async ({ page }) => {
  await fixture(page);
  await page.goto(`/w/${workspaceId}`);
  await expect(page.getByRole("heading", { name: "Founder team" })).toBeVisible();
  await page.route(`**/workspaces/${workspaceId}/meetings`, (route) =>
    route.fulfill({ status: 503, json: { code: "AUTHZ_UNAVAILABLE" } }),
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("session is still signed in");
  await expect(page.getByText("Acme renewal")).toHaveCount(0);
  await expect(page.getByText("founder@example.test")).toBeVisible();
});
test("calendar selection and disconnect use versioned commands without claiming automatic capture", async ({
  page,
}) => {
  await fixture(page);
  const id = "99999999-9999-4999-8999-999999999999";
  let record = {
    id,
    workspaceId,
    provider: "google",
    status: "connected",
    calendarId: "primary-id",
    calendarName: "Primary",
    version: 1,
    automatic: false,
    errorCode: null,
    cleanupPending: false,
  };
  await page.route("**/connections/calendar/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path.endsWith("/providers"))
      return route.fulfill({ json: { providers: ["google"], automaticCaptureReady: false } });
    if (path.endsWith("/calendars"))
      return route.fulfill({
        json: {
          items: [{ id: "team-id", name: "Customer calls", primary: false }],
          nextCursor: null,
        },
      });
    if (path.endsWith("/occurrences"))
      return route.fulfill({
        json: {
          window: { startsAt: "2026-10-12T00:00:00Z", endsAt: "2026-10-26T00:00:00Z" },
          items: [],
          nextCursor: null,
        },
      });
    if (path.endsWith(`/${id}/calendar`)) {
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      expect(request.postDataJSON()).toEqual({ calendarId: "team-id", expectedVersion: 1 });
      record = { ...record, calendarId: "team-id", calendarName: "Customer calls", version: 2 };
      return route.fulfill({ json: record });
    }
    if (path.endsWith(`/${id}/disconnect`)) {
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      expect(request.postDataJSON()).toEqual({ expectedVersion: 2 });
      record = { ...record, status: "disconnected", version: 3 };
      return route.fulfill({ json: record });
    }
    return route.fulfill({ json: [record] });
  });
  await page.goto(`/w/${workspaceId}`);
  await page.getByRole("button", { name: "Calendar connections", exact: true }).click();
  const panel = page.getByRole("region", { name: "Calendar connections" });
  await expect(panel).toContainText("Automatic meeting capture is not enabled");
  await panel.getByRole("button", { name: "Preview upcoming events", exact: true }).click();
  await expect(panel).toContainText("No events in this page");
  await panel.getByRole("combobox", { name: "Calendar", exact: true }).selectOption("team-id");
  await panel.getByRole("button", { name: "Save calendar", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "Customer calls", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Disconnect calendar", exact: true }).click();
  await expect(panel.getByRole("status").filter({ hasText: /^google:/ })).toContainText(
    "disconnected",
  );
  await expect(panel.getByRole("combobox", { name: "Calendar", exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Second workspace" }).click();
  await expect(panel).toHaveCount(0);
});
