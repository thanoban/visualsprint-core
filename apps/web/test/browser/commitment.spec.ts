import { test, expect, type Page } from "@playwright/test";
const meetingId = "55555555-5555-4555-8555-555555555555",
  ownerId = "33333333-3333-4333-8333-333333333333",
  jobId = "99999999-9999-4999-8999-999999999999",
  captureId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  segmentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  itemId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
async function fixture(page: Page, reader = false) {
  let item: Record<string, unknown> | null = reader
    ? {
        id: itemId,
        meetingId,
        kind: "commitment",
        title: "Accepted customer follow-up",
        text: "Human reviewed private statement",
        ownerId: null,
        dueDate: null,
        state: "open",
        version: 1,
        citations: [{ captureId, segmentId, revision: 2 }],
        sourcePartial: true,
        humanCorrected: true,
        evidenceStatus: "current",
      }
    : null;
  const commands: Record<string, unknown>[] = [];
  await page.route("**/api/v3/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    expect(request.headers().authorization).toBe("Bearer controlled-review-fixture");
    if (
      url.searchParams.get("scopeId") === "66666666-6666-4666-8666-666666666666" ||
      path.includes("66666666-6666-4666-8666-666666666666")
    )
      return route.fulfill({ status: 403, json: { code: "SOURCE_FORBIDDEN" } });
    if (path.endsWith("/members"))
      return route.fulfill({
        json: [{ userId: ownerId, role: "owner", active: true, version: 1 }],
      });
    if (path.endsWith("/summaries"))
      return route.fulfill({
        json: [
          {
            id: jobId,
            status: "complete",
            result: {
              claims: [
                {
                  kind: "commitment",
                  text: "We will send the revised offer.",
                  citation: { meetingId, captureId, segmentId, revision: 2 },
                },
              ],
            },
          },
        ],
      });
    if (path.endsWith("/decisions")) return route.fulfill({ json: [] });
    if (path.endsWith("/commitments")) {
      if (request.method() === "GET") return route.fulfill({ json: item ? [item] : [] });
      expect(reader).toBe(false);
      const body = request.postDataJSON();
      expect(body.confirmed).toBe(true);
      expect(body.expectedMeetingVersion).toBe(1);
      expect(body.content.ownerId).toBeNull();
      expect(body.content.dueDate).toBeNull();
      expect(body.content.citations).toEqual([{ captureId, segmentId, revision: 2 }]);
      expect(body.proposal).toEqual({ jobId, claimIndex: 0 });
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      commands.push(body);
      item = {
        id: itemId,
        meetingId,
        kind: "commitment",
        ...body.content,
        state: "open",
        version: 1,
        sourcePartial: true,
        humanCorrected: true,
        evidenceStatus: "current",
      };
      return route.fulfill({ status: 201, json: item });
    }
    if (path.endsWith("/commitments/" + itemId) && request.method() === "PATCH") {
      const body = request.postDataJSON();
      expect(body.confirmed).toBe(true);
      expect(body.expectedVersion).toBe(1);
      expect(body.proposal).toBeUndefined();
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      commands.push(body);
      item = { ...item, ...body.content, version: 2 };
      return route.fulfill({ json: item });
    }
    return route.fulfill({ status: 404, json: { code: "NOT_FOUND" } });
  });
  return commands;
}
test("human review checkbox gates acceptance and corrections without inferring ownership/date or executing scripts", async ({
  page,
}) => {
  const commands = await fixture(page);
  await page.goto("/commitment.html");
  await page.getByRole("button", { name: "Use this evidence for review" }).click();
  await page.getByLabel("Reviewed title").fill("Customer offer");
  await page
    .getByLabel("Reviewed statement")
    .fill("Human correction <script>window.reviewLeak=true</script>");
  const submit = page.getByRole("button", { name: "Accept reviewed record" });
  await expect(submit).toBeDisabled();
  expect(commands.length).toBe(0);
  await page.getByRole("checkbox", { name: /I reviewed the source/ }).check();
  await submit.click();
  await expect(page.getByRole("heading", { name: "commitment: Customer offer" })).toBeVisible();
  expect(commands.length).toBe(1);
  expect(await page.evaluate(() => Reflect.get(window, "reviewLeak"))).toBeUndefined();
  await page.getByRole("button", { name: "Review correction" }).click();
  await page.getByLabel("Reviewed statement").fill("Preserved corrected commitment");
  await expect(page.getByRole("button", { name: "Save reviewed correction" })).toBeDisabled();
  await page.getByRole("checkbox", { name: /I reviewed the source/ }).check();
  await page.getByRole("button", { name: "Save reviewed correction" }).click();
  await expect(page.getByText("Preserved corrected commitment", { exact: true })).toBeVisible();
  expect(commands.length).toBe(2);
});
test("shared read view exposes no acceptance controls and switching scope removes previous private records", async ({
  page,
}) => {
  await fixture(page, true);
  await page.goto("/commitment.html?reader=1");
  await expect(page.getByText("Human reviewed private statement", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review correction" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Accept reviewed record" })).toHaveCount(0);
  await page.getByRole("button", { name: "Switch meeting scope" }).click();
  await expect(page.getByText("Human reviewed private statement", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("alert")).toBeVisible();
});
