import { test, expect, type Page } from "@playwright/test";
const workspaceId = "11111111-1111-4111-8111-111111111111",
  meetingId = "55555555-5555-4555-8555-555555555555",
  agendaId = "77777777-7777-4777-8777-777777777777";
async function fixture(page: Page, { existing = false, uncertain = false, conflict = false } = {}) {
  let version = 1,
    allowed = true,
    first = true;
  let agenda: Record<string, unknown> | null = existing
    ? {
        id: agendaId,
        meetingId,
        title: "Private approved agenda",
        body: "Original owner-reviewed agenda text",
        version: 1,
        reviewed: true,
        createdAt: "2026-10-15T00:00:00Z",
        updatedAt: "2026-10-15T00:00:00Z",
      }
    : null;
  const commands: { method: string; path: string; body: Record<string, unknown>; key: string }[] =
      [],
    replays = new Map<string, unknown>();
  await page.route("**/api/v3/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    expect(request.headers().authorization).toBe("Bearer controlled-agenda-fixture");
    if (!allowed || path.includes("66666666-6666-4666-8666-666666666666"))
      return route.fulfill({ status: 403, json: { code: "FORBIDDEN" } });
    if (path.endsWith(`/meetings/${meetingId}`))
      return route.fulfill({
        json: {
          id: meetingId,
          workspaceId,
          ownerId: "33333333-3333-4333-8333-333333333333",
          title: "Customer call",
          notes: "",
          version,
          blocked: false,
          joinUrl: null,
          createdAt: "2026-10-15T00:00:00Z",
        },
      });
    if (path.endsWith("/agendas") && request.method() === "GET")
      return route.fulfill({ json: agenda ? [agenda] : [] });
    if (path.includes("/agendas") && request.method() !== "GET") {
      const body = request.postDataJSON(),
        key = request.headers()["idempotency-key"]!;
      expect(key).toBeTruthy();
      expect(body.confirmed).toBe(true);
      commands.push({ method: request.method(), path, body, key });
      if (replays.has(key)) return route.fulfill({ json: replays.get(key) });
      if (conflict && first) {
        first = false;
        version++;
        return route.fulfill({ status: 409, json: { code: "SOURCE_MEETING_CHANGED" } });
      }
      expect(body.expectedMeetingVersion).toBe(version);
      if (request.method() === "PATCH" || path.endsWith("/delete"))
        expect(body.expectedVersion).toBe(agenda?.version);
      version++;
      if (path.endsWith("/delete")) {
        const deleted = {
          id: agendaId,
          meetingId,
          deleted: true,
          version: Number(agenda!.version) + 1,
        };
        agenda = null;
        replays.set(key, deleted);
        return route.fulfill({ json: deleted });
      }
      agenda = {
        id: agendaId,
        meetingId,
        title: body.title,
        body: body.body,
        version: request.method() === "PATCH" ? Number(agenda?.version) + 1 : 1,
        reviewed: true,
        createdAt: "2026-10-15T00:00:00Z",
        updatedAt: "2026-10-15T01:00:00Z",
      };
      replays.set(key, agenda);
      if (uncertain && first) {
        first = false;
        return route.fulfill({ status: 503, json: { code: "UNAVAILABLE" } });
      }
      return route.fulfill({ status: request.method() === "POST" ? 201 : 200, json: agenda });
    }
    throw new Error(`Unexpected operation ${request.method()} ${path}`);
  });
  return { commands, deny: () => (allowed = false) };
}
async function fill(page: Page) {
  await page.getByLabel("Reviewed agenda title").fill("Review customer follow-through");
  await page.getByLabel("Reviewed agenda text").fill("<script>window.agendaLeak=true</script>");
}
test("owner explicitly reviews create/correct/delete and reloads meeting versions between commands", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/agenda.html");
  await fill(page);
  await expect(
    page.getByRole("button", { name: "Save reviewed agenda", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("checkbox", { name: "I reviewed and confirm this exact agenda text." })
    .check();
  await page.getByRole("button", { name: "Save reviewed agenda", exact: true }).click();
  await expect(page.getByText("Meeting reloads: 1; current revision 2.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Owner-reviewed agendas" })).toContainText(
    "<script>window.agendaLeak=true</script>",
  );
  expect(
    await page.evaluate(() => Boolean((window as unknown as { agendaLeak?: boolean }).agendaLeak)),
  ).toBe(false);
  await page.getByRole("button", { name: "Review agenda correction" }).click();
  await page.getByLabel("Reviewed agenda text").fill("Human corrected agenda");
  await expect(
    page.getByRole("checkbox", { name: "I reviewed and confirm this exact agenda text." }),
  ).not.toBeChecked();
  await page
    .getByRole("checkbox", { name: "I reviewed and confirm this exact agenda text." })
    .check();
  await page.getByRole("button", { name: "Save reviewed agenda correction", exact: true }).click();
  await expect(page.getByText("Meeting reloads: 2; current revision 3.")).toBeVisible();
  await page.getByRole("button", { name: "Review agenda deletion" }).click();
  await expect(
    page.getByRole("button", { name: "Delete reviewed agenda", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("checkbox", { name: "I explicitly confirm deleting this exact reviewed agenda." })
    .check();
  await page.getByRole("button", { name: "Delete reviewed agenda", exact: true }).click();
  await expect(page.getByText("Meeting reloads: 3; current revision 4.")).toBeVisible();
  await expect(page.getByText("No owner-reviewed agenda saved.")).toBeVisible();
  expect(f.commands.map((value) => value.body.expectedMeetingVersion)).toEqual([1, 2, 3]);
  expect(f.commands[1]?.body.expectedVersion).toBe(1);
  expect(f.commands[2]?.body.expectedVersion).toBe(2);
  expect(new Set(f.commands.map((value) => value.key)).size).toBe(3);
});
test("uncertain agenda mutation locks replacements and retries the identical command key/body", async ({
  page,
}) => {
  const f = await fixture(page, { uncertain: true });
  await page.goto("/agenda.html");
  await fill(page);
  await page
    .getByRole("checkbox", { name: "I reviewed and confirm this exact agenda text." })
    .check();
  await page.getByRole("button", { name: "Save reviewed agenda", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry same agenda request" })).toBeEnabled();
  await expect(page.getByLabel("Reviewed agenda title")).toBeDisabled();
  await page.getByRole("button", { name: "Retry same agenda request" }).click();
  await expect(page.getByText("Meeting reloads: 1; current revision 2.")).toBeVisible();
  expect(f.commands).toHaveLength(2);
  expect(f.commands[0]?.key).toBe(f.commands[1]?.key);
  expect(f.commands[0]?.body).toEqual(f.commands[1]?.body);
});
test("version conflicts require renewed review and do not automatically resubmit", async ({
  page,
}) => {
  const f = await fixture(page, { conflict: true });
  await page.goto("/agenda.html");
  await fill(page);
  await page
    .getByRole("checkbox", { name: "I reviewed and confirm this exact agenda text." })
    .check();
  await page.getByRole("button", { name: "Save reviewed agenda", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("changed while you were editing");
  await expect(
    page.getByRole("checkbox", { name: "I reviewed and confirm this exact agenda text." }),
  ).not.toBeChecked();
  expect(f.commands).toHaveLength(1);
  await page
    .getByRole("checkbox", { name: "I reviewed and confirm this exact agenda text." })
    .check();
  await page.getByRole("button", { name: "Save reviewed agenda", exact: true }).click();
  await expect(page.getByText("Meeting reloads: 1; current revision 3.")).toBeVisible();
  expect(f.commands[1]?.body.expectedMeetingVersion).toBe(2);
  expect(f.commands[0]?.key).not.toBe(f.commands[1]?.key);
});
test("shared readers are read-only; permission loss and scope changes remove private agendas", async ({
  page,
}) => {
  const f = await fixture(page, { existing: true });
  await page.goto("/agenda.html?reader=1");
  await expect(page.getByText("Original owner-reviewed agenda text")).toBeVisible();
  await expect(page.getByLabel("Reviewed agenda text")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review agenda deletion" })).toHaveCount(0);
  f.deny();
  await page.getByRole("button", { name: "Refresh reviewed agendas" }).click();
  await expect(page.getByRole("alert")).toContainText("no longer available");
  await expect(page.getByText("Original owner-reviewed agenda text")).toHaveCount(0);
  expect(f.commands).toHaveLength(0);
  await page.getByRole("button", { name: "Switch agenda scope" }).click();
  await expect(page.getByText("Private approved agenda")).toHaveCount(0);
});
