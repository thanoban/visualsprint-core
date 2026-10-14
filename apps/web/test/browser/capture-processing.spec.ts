import { test, expect, type Page } from "@playwright/test";
async function fixture(page: Page) {
  let state = "disabled",
    version = 1,
    consentId: string | null = null,
    enabled = 0,
    withdrawn = 0;
  const status = () => ({
    state,
    intentVersion: version,
    consentId,
    consentVersion: consentId ? 1 : null,
    policyVersion: "english-text-v1",
    transcriptRevision: 0,
    errorCode: null,
  });
  await page.route("**/api/v3/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    expect(request.headers().authorization).toBe("Bearer controlled-processing-fixture");
    if (path.endsWith("/captures/99999999-9999-4999-8999-999999999999"))
      return route.fulfill({ json: { processing: state === "disabled" ? null : status() } });
    if (path.endsWith("/processing-consent") && request.method() === "POST") {
      expect(request.postDataJSON()).toEqual({ consent: true, policyVersion: "english-text-v1" });
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      enabled++;
      state = "consent_pending";
      version++;
      return route.fulfill({ status: 202, json: status() });
    }
    if (path.endsWith("/processing-consent/withdraw")) {
      expect(request.postDataJSON()).toEqual({ expectedIntentVersion: version });
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      withdrawn++;
      state = "withdraw_requested";
      version++;
      return route.fulfill({ status: 202, json: status() });
    }
    throw new Error(`Unexpected external operation ${request.method()} ${path}`);
  });
  return {
    enabled: () => enabled,
    withdrawn: () => withdrawn,
    ready: () => {
      state = "ready";
      consentId = "88888888-8888-4888-8888-888888888888";
    },
    revoked: () => {
      state = "revoked";
      version++;
    },
    configError: () => {
      state = "configuration_error";
    },
  };
}
test("processing permission is explicit and pending creation can be durably withdrawn before a consent ID exists", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/capture-processing.html");
  await expect(
    page.getByRole("button", { name: "Enable processing for this capture" }),
  ).toBeDisabled();
  expect(f.enabled()).toBe(0);
  await page
    .getByRole("checkbox", {
      name: /I explicitly authorize automatic English transcript processing/,
    })
    .check();
  await page.getByRole("button", { name: "Enable processing for this capture" }).click();
  await expect(page.getByText(/Consent setup is pending/)).toBeVisible();
  expect(f.enabled()).toBe(1);
  await page.getByRole("button", { name: "Withdraw automatic processing" }).click();
  await expect(page.getByText(/Withdrawal is recorded/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Withdraw automatic processing" })).toHaveCount(0);
  expect(f.withdrawn()).toBe(1);
  f.revoked();
  await page.getByRole("button", { name: "Refresh consent status" }).click();
  await expect(page.getByText(/Ordinary capture may continue/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Enable processing for this capture" }),
  ).toHaveCount(0);
  await expect(page.getByText(/use a new capture to opt in again/)).toBeVisible();
});
test("ready grant is not represented as a completed summary; shared readers cannot enable or withdraw", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/capture-processing.html");
  f.ready();
  await page.getByRole("button", { name: "Refresh consent status" }).click();
  await expect(page.getByText(/this is not proof that a summary exists/)).toBeVisible();
  f.configError();
  await page.getByRole("button", { name: "Refresh consent status" }).click();
  await expect(page.getByText(/has not silently switched to ordinary capture/)).toBeVisible();
  await page.goto("/capture-processing.html?reader=1");
  await expect(
    page.getByRole("button", { name: "Enable processing for this capture" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Withdraw automatic processing" })).toHaveCount(0);
  expect(f.enabled()).toBe(0);
  expect(f.withdrawn()).toBe(0);
});

test("mounted capture flow sends explicit opt-in only when selected and withdrawal does not stop capture", async ({
  page,
}) => {
  const captureId = "99999999-9999-4999-8999-999999999999",
    meetingId = "22222222-2222-4222-8222-222222222222";
  let created = false,
    withdrawn = false,
    stops = 0;
  const processing = () => ({
    state: withdrawn ? "withdraw_requested" : "consent_pending",
    intentVersion: withdrawn ? 2 : 1,
    consentId: null,
    consentVersion: null,
    policyVersion: "english-text-v1",
    transcriptRevision: 0,
    errorCode: null,
  });
  const capture = () => ({
    id: captureId,
    state: "scheduled",
    ready: false,
    coverage: "unknown",
    transcriptHealth: "unknown",
    errorCode: null,
    version: 1,
    stopRequested: false,
  });
  await page.route("**/api/v3/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    expect(request.headers().authorization).toBe("Bearer controlled-processing-fixture");
    if (path.endsWith(`/meetings/${meetingId}/captures`))
      return route.fulfill({ json: created ? [capture()] : [] });
    if (path.endsWith(`/captures/${captureId}`))
      return route.fulfill({ json: { ...capture(), processing: processing() } });
    if (path.endsWith(`/captures/${captureId}/transcript`))
      return route.fulfill({ json: { totalSegments: 0, segments: [] } });
    if (path.endsWith("/captures") && request.method() === "POST") {
      expect(request.postDataJSON()).toEqual({
        meetingId,
        expectedMeetingVersion: 1,
        processing: { consent: true, policyVersion: "english-text-v1" },
      });
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      created = true;
      return route.fulfill({ status: 202, json: capture() });
    }
    if (path.endsWith("/processing-consent/withdraw")) {
      expect(request.postDataJSON()).toEqual({ expectedIntentVersion: 1 });
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      withdrawn = true;
      return route.fulfill({ status: 202, json: processing() });
    }
    if (path.endsWith("/stop")) {
      stops++;
      return route.fulfill({ json: capture() });
    }
    throw new Error(`Unexpected operation ${request.method()} ${path}`);
  });
  await page.goto("/capture-processing.html?mounted=1");
  const panel = page.getByRole("region", { name: "Meeting capture" });
  const checkbox = panel.getByRole("checkbox", { name: /for this new capture/ });
  await expect(checkbox).not.toBeChecked();
  await checkbox.check();
  await panel.getByRole("button", { name: "Start capture", exact: true }).click();
  await expect(panel).toContainText("Consent setup is pending");
  await expect(panel.getByRole("button", { name: "Start capture", exact: true })).toHaveCount(0);
  await panel.getByRole("button", { name: "Withdraw automatic processing" }).click();
  await expect(panel).toContainText("Withdrawal is recorded");
  await expect(panel.getByRole("button", { name: "Stop capture", exact: true })).toBeVisible();
  expect(stops).toBe(0);
});

test("mounted status lookup fails closed and clears transcript and consent commands on revocation", async ({
  page,
}) => {
  const captureId = "99999999-9999-4999-8999-999999999999";
  const capture = {
    id: captureId,
    state: "complete",
    ready: true,
    coverage: "complete",
    transcriptHealth: "healthy",
    errorCode: null,
    version: 1,
    stopRequested: false,
  };
  let denied = false;
  await page.route("**/api/v3/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/captures")) return route.fulfill({ json: [capture] });
    if (path.endsWith(`/captures/${captureId}`))
      return denied
        ? route.fulfill({ status: 403, json: { code: "FORBIDDEN" } })
        : route.fulfill({ json: { ...capture, processing: null } });
    if (path.endsWith("/transcript"))
      return route.fulfill({
        json: {
          totalSegments: 1,
          segments: [
            { id: "segment", text: "Owner confidential text", speakerLabel: null, startMs: 0 },
          ],
        },
      });
    throw new Error(`Unexpected operation ${path}`);
  });
  await page.goto("/capture-processing.html?mounted=1");
  await expect(page.getByText("Owner confidential text", { exact: false })).toBeVisible();
  denied = true;
  await expect(page.getByRole("alert")).toContainText("no longer available", { timeout: 10000 });
  await expect(page.getByText("Owner confidential text", { exact: false })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Enable processing for this capture" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start capture", exact: true })).toHaveCount(0);
});
