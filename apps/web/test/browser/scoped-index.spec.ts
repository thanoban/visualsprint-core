import { test, expect, type Page } from "@playwright/test";
const projectId = "44444444-4444-4444-8444-444444444444",
  jobId = "99999999-9999-4999-8999-999999999999";
async function fixture(page: Page) {
  let creates = 0,
    reads = 0,
    changed = false,
    revoked = false,
    disabled = false,
    foreignScope = false;
  const job = (status: string) => ({
    id: jobId,
    scope: {
      kind: "project",
      id: foreignScope ? "77777777-7777-4777-8777-777777777777" : projectId,
    },
    status,
    cursor: status === "complete" ? 2 : 0,
    totalChunks: 2,
    sourceFingerprint: "a".repeat(64),
    errorCode: changed ? "SOURCE_CHANGED" : null,
    createdAt: "2026-10-14T00:00:00Z",
  });
  await page.route("**/api/v3/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    expect(req.headers().authorization).toBe("Bearer controlled-index-fixture");
    if (path.endsWith("/indexes") && req.method() === "POST") {
      creates++;
      expect(req.postDataJSON()).toEqual({ scope: { kind: "project", id: projectId } });
      expect(req.headers()["idempotency-key"]).toBeTruthy();
      return disabled
        ? route.fulfill({ status: 503, json: { code: "RETRIEVAL_DISABLED" } })
        : route.fulfill({ status: 202, json: job("queued") });
    }
    if (path.endsWith("/indexes/" + jobId)) {
      reads++;
      if (revoked) return route.fulfill({ status: 403, json: { code: "SOURCE_FORBIDDEN" } });
      return route.fulfill({ json: job(changed ? "failed" : reads > 1 ? "complete" : "queued") });
    }
    throw new Error(`Unexpected API call ${req.method()} ${path}`);
  });
  return {
    creates: () => creates,
    change: () => {
      changed = true;
    },
    revoke: () => {
      revoked = true;
    },
    disable: () => {
      disabled = true;
    },
    corruptScope: () => {
      foreignScope = true;
    },
  };
}
async function build(page: Page) {
  await page
    .getByRole("checkbox", {
      name: "I choose to build this scoped text index using the configured embedding provider.",
    })
    .check();
  await page.getByRole("button", { name: "Build scoped index", exact: true }).click();
}

test("index build requires explicit embedding choice and becomes ready only after persisted progress; reload does not create again", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/scoped-index.html");
  await expect(
    page.getByRole("button", { name: "Build scoped index", exact: true }),
  ).toBeDisabled();
  expect(f.creates()).toBe(0);
  await build(page);
  await expect(page.getByRole("article", { name: "Index progress" })).toContainText("queued");
  await expect(page.getByText("Indexed answers: enabled", { exact: true })).toBeVisible();
  expect(f.creates()).toBe(1);
  await page.reload();
  await expect(page.getByText("Indexed answers: enabled", { exact: true })).toBeVisible();
  expect(f.creates()).toBe(1);
});

test("an opaque index from another scope never grants UI readiness", async ({ page }) => {
  const f = await fixture(page);
  await page.goto("/scoped-index.html");
  await build(page);
  await expect(page.getByText("Indexed answers: enabled", { exact: true })).toBeVisible();
  f.corruptScope();
  await page.getByRole("button", { name: "Refresh existing index" }).click();
  await expect(page.getByText("Indexed answers: disabled", { exact: true })).toBeVisible();
  await expect(page.getByRole("article", { name: "Index progress" })).toHaveCount(0);
  expect(f.creates()).toBe(1);
});
test("stale source and revoked index remove readiness without implicit fallback or replacement build", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/scoped-index.html");
  await build(page);
  await expect(page.getByText("Indexed answers: enabled", { exact: true })).toBeVisible();
  f.change();
  await page.getByRole("button", { name: "Refresh existing index" }).click();
  await expect(page.getByText("Indexed answers: disabled", { exact: true })).toBeVisible();
  await expect(page.getByText(/This index cannot authorize an indexed answer/)).toBeVisible();
  expect(f.creates()).toBe(1);
  f.revoke();
  await page.getByRole("button", { name: "Refresh existing index" }).click();
  await expect(page.getByRole("article", { name: "Index progress" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh existing index" })).toHaveCount(0);
  expect(f.creates()).toBe(1);
});
test("scope switches clear an index and disabled native retrieval never advertises readiness", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/scoped-index.html");
  await build(page);
  await expect(page.getByText("Indexed answers: enabled", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Switch index scope" }).click();
  await expect(page.getByText("Indexed answers: disabled", { exact: true })).toBeVisible();
  await expect(page.getByRole("article", { name: "Index progress" })).toHaveCount(0);
  await page.goto("/scoped-index.html");
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  f.disable();
  await build(page);
  await expect(page.getByRole("alert")).toContainText("not enabled by the administrator");
  await expect(page.getByText("Indexed answers: disabled", { exact: true })).toBeVisible();
});
