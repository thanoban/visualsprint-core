import { test, expect, type Page } from "@playwright/test";
const workspaceId = "11111111-1111-4111-8111-111111111111",
  ownerId = "33333333-3333-4333-8333-333333333333",
  projectId = "44444444-4444-4444-8444-444444444444",
  targetId = "55555555-5555-4555-8555-555555555555",
  historyId = "66666666-6666-4666-8666-666666666666",
  jobId = "99999999-9999-4999-8999-999999999999",
  captureId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  segmentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  recordId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
async function fixture(page: Page) {
  let creates = 0,
    reads = 0,
    revoked = false,
    unavailable = false,
    invalidated = false;
  const result = {
    meetingId: targetId,
    meetingVersion: 1,
    historyScope: { kind: "project", id: projectId },
    sourceFingerprint: "a".repeat(64),
    sourceVersions: [
      { meetingId: historyId, version: 2, captureId, captureVersion: 4, coverage: "partial" },
    ],
    findings: [
      {
        kind: "decision",
        text: "Use the agreed onboarding approach.",
        citation: { meetingId: historyId, captureId, segmentId, revision: 2 },
      },
    ],
    questions: [
      {
        kind: "clarification",
        text: "Verify current status of: Send revised offer",
        commitmentId: recordId,
        commitmentVersion: 2,
        sourceMeetingId: historyId,
        statusVerifiedAt: null,
      },
    ],
    reviewedRecords: [
      {
        id: recordId,
        meetingId: historyId,
        version: 2,
        kind: "commitment",
        title: "Reviewed offer",
        text: "Human review <script>window.preparationLeak=true</script>",
        state: "completed",
        ownerId: null,
        dueDate: null,
        statusSource: "human_review",
        evidenceStatus: "changed",
        sourcePartial: true,
        citations: [{ captureId, segmentId, revision: 2 }],
        externalStatus: "unknown",
        externalVerifiedAt: null,
      },
    ],
    partial: true,
    reviewRequired: true,
  };
  const job = (status: string) => ({
    id: jobId,
    status,
    result: status === "complete" ? result : null,
    errorCode: status === "invalidated" ? "SOURCE_CHANGED" : null,
    attempts: 1,
    createdAt: "2026-10-14T00:00:00Z",
  });
  await page.route("**/api/v3/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    expect(request.headers().authorization).toBe("Bearer controlled-preparation-fixture");
    if (path.endsWith("/customers")) return route.fulfill({ json: [] });
    if (path.endsWith("/meetings"))
      return route.fulfill({
        json: [
          {
            id: historyId,
            workspaceId,
            ownerId,
            title: "Previous call",
            notes: "",
            joinUrl: null,
            version: 2,
            blocked: false,
            createdAt: "2026-10-13T00:00:00Z",
          },
        ],
      });
    if (path.endsWith("/preparations") && request.method() === "POST") {
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      expect(request.postDataJSON()).toEqual({
        meetingId: targetId,
        historyScope: { kind: "project", id: projectId },
        confirmedScope: true,
      });
      creates++;
      return route.fulfill({ status: 202, json: job("queued") });
    }
    if (path.endsWith("/preparations/" + jobId)) {
      reads++;
      if (revoked) return route.fulfill({ status: 403, json: { code: "SOURCE_FORBIDDEN" } });
      if (unavailable) return route.fulfill({ status: 503, json: { code: "SOURCE_UNAVAILABLE" } });
      return route.fulfill({
        json: job(invalidated ? "invalidated" : reads > 1 ? "complete" : "queued"),
      });
    }
    throw new Error(`Unexpected write or API path: ${request.method()} ${path}`);
  });
  return {
    creates: () => creates,
    reads: () => reads,
    revoke: () => {
      revoked = true;
    },
    outage: (value: boolean) => {
      unavailable = value;
    },
    invalidate: () => {
      invalidated = true;
    },
  };
}
async function request(page: Page) {
  await page.getByLabel("Preparation history").selectOption(`project:${projectId}`);
  await page
    .getByRole("checkbox", { name: "I confirm this exact history scope for this preparation." })
    .check();
  await page.getByRole("button", { name: "Prepare reviewed-history draft", exact: true }).click();
}

test("preparation requires scope confirmation, polls a durable job and keeps human completion distinct from verified tasks", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/preparation.html");
  const submit = page.getByRole("button", { name: "Prepare reviewed-history draft", exact: true });
  await expect(submit).toBeDisabled();
  await page.getByLabel("Preparation history").selectOption(`project:${projectId}`);
  await expect(submit).toBeDisabled();
  expect(f.creates()).toBe(0);
  await page
    .getByRole("checkbox", { name: "I confirm this exact history scope for this preparation." })
    .check();
  await submit.click();
  await expect(page.getByText("queued", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "Human-reviewed status: completed; revision 2. External task status: unknown, not verified.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText(/Partial history:/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Open evidence meeting" })).toHaveAttribute(
    "href",
    `/w/${workspaceId}?meetingId=${historyId}`,
  );
  expect(await page.evaluate(() => Reflect.get(window, "preparationLeak"))).toBeUndefined();
  expect(f.creates()).toBe(1);
  await page.reload();
  await expect(page.getByText(/Human-reviewed status: completed/)).toBeVisible();
  expect(f.creates()).toBe(1);
});

test("preparation hides stale content on outages/revocation without creating a replacement", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/preparation.html");
  await request(page);
  await expect(page.getByText(/Human-reviewed status: completed/)).toBeVisible();
  f.outage(true);
  await page.getByRole("button", { name: "Refresh existing preparation" }).click();
  await expect(page.getByText(/Human-reviewed status: completed/)).toHaveCount(0);
  await expect(page.getByText(/The previous draft is hidden/)).toBeVisible();
  expect(f.creates()).toBe(1);
  f.outage(false);
  await page.getByRole("button", { name: "Refresh existing preparation" }).click();
  await expect(page.getByText(/Human-reviewed status: completed/)).toBeVisible();
  f.revoke();
  await page.getByRole("button", { name: "Refresh existing preparation" }).click();
  await expect(page.getByText(/Human-reviewed status: completed/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh existing preparation" })).toHaveCount(0);
  expect(f.creates()).toBe(1);
});

test("invalidated sources and meeting switches remove old preparation; shared readers have no preparation controls", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/preparation.html");
  await request(page);
  await expect(page.getByText(/Human-reviewed status: completed/)).toBeVisible();
  f.invalidate();
  await page.getByRole("button", { name: "Refresh existing preparation" }).click();
  await expect(page.getByText(/The old draft was removed/)).toBeVisible();
  await expect(page.getByText(/Human-reviewed status: completed/)).toHaveCount(0);
  await page.getByRole("button", { name: "Switch preparation meeting" }).click();
  await expect(page.getByRole("article", { name: "Preparation draft" })).toHaveCount(0);
  await page.goto("/preparation.html?reader=1");
  await expect(
    page.getByRole("button", { name: "Prepare reviewed-history draft", exact: true }),
  ).toHaveCount(0);
});
