import { test, expect, type Page } from "@playwright/test";
import { exportFixture } from "../fixtures/reviewed-export.js";
async function fixture(page: Page, value: unknown) {
  await page.addInitScript(() => {
    URL.createObjectURL = (blob: Blob | MediaSource) => {
      if (blob instanceof Blob)
        void blob.text().then((text) => {
          (window as unknown as { downloadedArtifact?: unknown }).downloadedArtifact =
            JSON.parse(text);
        });
      return "blob:controlled";
    };
    URL.revokeObjectURL = () => {};
    HTMLAnchorElement.prototype.click = () => {};
  });
  const meetingId = "55555555-5555-4555-8555-555555555555",
    id = "99999999-9999-4999-8999-999999999999";
  let downloaded = 0;
  await page.route("**/api/v3/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    expect(request.headers().authorization).toBe("Bearer controlled-agenda-fixture");
    if (path.endsWith("/exports") && request.method() === "POST") {
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      expect(request.postDataJSON()).toEqual({ meetingId, format: "json" });
      return route.fulfill({
        status: 202,
        json: {
          id,
          meetingId,
          state: "complete",
          format: "json",
          version: 2,
          errorCode: null,
          expiresAt: "2099-01-01T00:00:00Z",
        },
      });
    }
    if (path.endsWith("/download")) {
      downloaded++;
      return route.fulfill({ json: value });
    }
    throw new Error(`Unexpected request ${path}`);
  });
  return () => downloaded;
}
async function download(page: Page) {
  await page.goto("/agenda.html?exports=1");
  await page.getByRole("button", { name: "Create JSON export" }).click();
  await page.getByRole("button", { name: "Download authorized export" }).click();
}
test("authorized schema2 download retains decisions commitments agendas and source proofs", async ({
  page,
}) => {
  const value = exportFixture(),
    count = await fixture(page, value);
  await download(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { downloadedArtifact?: unknown }).downloadedArtifact,
      ),
    )
    .toEqual(value);
  expect(count()).toBe(1);
  await expect(page.getByText(/Schema-2 artifact downloaded/)).toBeVisible();
});
test("malformed schema2 is not downloaded and legacy schema1 is labeled incomplete reviewed coverage", async ({
  page,
}) => {
  const value = exportFixture();
  await fixture(page, { ...value, reviewed: { ...value.reviewed, complete: false } });
  await download(page);
  await expect(page.getByRole("alert")).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { downloadedArtifact?: unknown }).downloadedArtifact,
    ),
  ).toBeUndefined();
  await page.unroute("**/api/v3/**");
  const legacy = {
    schemaVersion: 1,
    meetingId: value.meetingId,
    version: 1,
    title: value.title,
    notes: value.notes,
    captures: [],
  };
  await fixture(page, legacy);
  await download(page);
  await expect(page.getByText(/Legacy schema-1 artifact downloaded/)).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { downloadedArtifact?: unknown }).downloadedArtifact,
      ),
    )
    .toEqual(legacy);
});
