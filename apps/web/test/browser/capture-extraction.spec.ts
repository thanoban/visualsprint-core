import { test, expect, type Page } from "@playwright/test";
const meetingId = "55555555-5555-4555-8555-555555555555",
  captureId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  segmentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  jobId = "99999999-9999-4999-8999-999999999999";
async function fixture(page: Page) {
  const state = {
    status: "complete",
    error: "",
    reads: 0,
    writes: [] as Record<string, any>[],
    foreign: false,
  };
  await page.route("**/api/v3/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path.includes("22222222-") || path.includes("66666666-"))
      return json({ code: "SOURCE_FORBIDDEN" }, 403);
    if (path.includes("capture-extractions")) {
      expect(request.method()).toBe("GET");
      state.reads++;
      if (state.error)
        return json(
          { code: state.error },
          state.error === "CAPTURE_EXTRACTION_NOT_CONFIGURED"
            ? 503
            : state.error === "SOURCE_CHANGED"
              ? 409
              : 403,
        );
      const job = {
        id: jobId,
        meetingId,
        captureId,
        transcriptRevision: 4,
        status: state.status,
        errorCode: state.status === "failed" ? "MODEL_DISPATCH_UNKNOWN" : null,
        createdAt: "2026-10-16T00:00:00Z",
      };
      if (path.endsWith("/capture-extractions")) return json({ jobs: [job] });
      return json({
        ...job,
        result: {
          claims: [
            {
              kind: "commitment",
              text: "We will send the offer. <script>window.draftLeak=true</script>",
              citation: {
                meetingId: state.foreign ? "66666666-6666-4666-8666-666666666666" : meetingId,
                captureId,
                segmentId,
                revision: 2,
              },
            },
          ],
          partial: true,
          unsupported: false,
          reviewRequired: true,
          sourceFingerprint: "hash",
          sourceVersions: [
            { meetingId, version: 1, captureId, captureVersion: 4, coverage: "partial" },
          ],
        },
      });
    }
    if (path.endsWith("/members") || path.endsWith("/summaries") || path.endsWith("/decisions"))
      return json([]);
    if (path.endsWith("/commitments")) {
      if (request.method() === "GET") return json([]);
      const body = request.postDataJSON();
      state.writes.push(body);
      expect(body.proposal).toBeNull();
      expect(body.confirmed).toBe(true);
      expect(body.expectedMeetingVersion).toBe(1);
      expect(body.content.citations).toEqual([{ captureId, segmentId, revision: 2 }]);
      return json(
        {
          id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          meetingId,
          kind: "commitment",
          ...body.content,
          state: "open",
          version: 1,
          sourcePartial: true,
          humanCorrected: true,
          evidenceStatus: "current",
        },
        201,
      );
    }
    return json({ code: "NOT_FOUND" }, 404);
  });
  return state;
}
test("private automatic draft uses explicit human evidence review with exact citations, not a fabricated manual proposal", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/capture-extraction.html");
  await page.getByRole("button", { name: "Review automatic commitment" }).click();
  await page.getByLabel("Reviewed title").fill("Send offer");
  await expect(page.getByText(/Reviewing automatic draft/)).toBeVisible();
  const accept = page.getByRole("button", { name: "Accept reviewed record" });
  await expect(accept).toBeDisabled();
  expect(state.writes).toHaveLength(0);
  await page.getByRole("checkbox", { name: /I reviewed the source/ }).check();
  await accept.click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(await page.evaluate(() => Reflect.get(window, "draftLeak"))).toBeUndefined();
});
test("polling and refresh read only; stale or revoked source clears draft and selected evidence", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/capture-extraction.html");
  await page.getByRole("button", { name: "Review automatic commitment" }).click();
  await page.getByLabel("Reviewed title").fill("Private review");
  state.error = "SOURCE_CHANGED";
  await page.getByRole("button", { name: "Refresh automatic drafts" }).click();
  await expect(page.getByText(/Source evidence changed/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Review automatic commitment" })).toHaveCount(0);
  await expect(page.getByLabel("Reviewed statement")).toHaveValue("");
  state.error = "SOURCE_FORBIDDEN";
  await page.getByRole("button", { name: "Refresh automatic drafts" }).click();
  await expect(page.getByText(/No previous draft is shown/)).toBeVisible();
  expect(state.writes).toHaveLength(0);
});
test("queued and failed jobs do not pretend consent-ready means a completed summary or retry model dispatch", async ({
  page,
}) => {
  const state = await fixture(page);
  state.status = "queued";
  await page.clock.install();
  await page.goto("/capture-extraction.html");
  await expect(page.getByText(/queued · transcript/)).toBeVisible();
  await page.clock.fastForward(11000);
  await expect.poll(() => state.reads).toBeGreaterThan(1);
  state.status = "failed";
  await page.getByRole("button", { name: "Refresh automatic drafts" }).click();
  await expect(page.getByText(/MODEL_DISPATCH_UNKNOWN/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Review automatic commitment" })).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});
test("reader cannot load owner-private drafts and losing ownership clears current review", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/capture-extraction.html?reader=1");
  await expect(
    page.getByRole("heading", { name: "Reviewed decisions and commitments" }),
  ).toBeVisible();
  expect(state.reads).toBe(0);
  await page.goto("/capture-extraction.html");
  await page.getByRole("button", { name: "Review automatic commitment" }).click();
  await page.getByRole("button", { name: "Become reader" }).click();
  await expect(page.getByRole("region", { name: "Automatic capture drafts" })).toHaveCount(0);
  await expect(page.getByLabel("Reviewed statement")).toHaveCount(0);
});
for (const scope of ["meeting", "workspace"])
  test(`${scope} switch removes old private drafts and form immediately`, async ({ page }) => {
    await fixture(page);
    await page.goto("/capture-extraction.html");
    await page.getByRole("button", { name: "Review automatic commitment" }).click();
    await page.getByLabel("Reviewed title").fill("Private previous scope");
    await page.getByRole("button", { name: `Switch ${scope}`, exact: true }).click();
    await expect(page.getByRole("button", { name: "Review automatic commitment" })).toHaveCount(0);
    await expect(page.getByLabel("Reviewed title")).toHaveValue("");
  });
test("malformed foreign citation never renders a reviewable draft", async ({ page }) => {
  const state = await fixture(page);
  state.foreign = true;
  await page.goto("/capture-extraction.html");
  await expect(page.getByText(/No previous draft is shown/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Review automatic commitment" })).toHaveCount(0);
});
test("operator-disabled automatic processing has a configuration explanation, not a login loop", async ({
  page,
}) => {
  const state = await fixture(page);
  state.error = "CAPTURE_EXTRACTION_NOT_CONFIGURED";
  await page.goto("/capture-extraction.html");
  await expect(page.getByText(/Automatic extraction is not enabled by the operator/)).toBeVisible();
  expect(state.reads).toBe(1);
  expect(state.writes).toHaveLength(0);
  await expect(page.getByRole("button", { name: "Review automatic commitment" })).toHaveCount(0);
});
