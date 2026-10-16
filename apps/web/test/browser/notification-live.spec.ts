import { test, expect, type Page } from "@playwright/test";
async function fixture(page: Page, disabled = false, malicious = false) {
  const state = { negotiations: 0, reads: 0, preferencesReads: 0, revoked: false };
  await page.addInitScript(() => {
    const sockets: unknown[] = [];
    Reflect.set(window, "fixtureSockets", sockets);
    class ControlledSocket {
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      closed = false;
      constructor(_url: string) {
        // Vite's development HMR socket is not a notification connection.
        if (!_url.startsWith("wss://fixture.webpubsub.azure.com/")) return;
        sockets.push(this);
        setTimeout(() => this.onopen?.(), 0);
      }
      close() {
        this.closed = true;
      }
    }
    Reflect.set(window, "WebSocket", ControlledSocket);
  });
  await page.route("**/api/v3/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path.endsWith("/realtime/negotiate")) {
      state.negotiations++;
      expect(request.method()).toBe("POST");
      expect(request.postData()).toBeNull();
      expect(new URL(request.url()).search).toBe("");
      if (disabled)
        return route.fulfill({ status: 503, json: { code: "REALTIME_NOT_CONFIGURED" } });
      const payload = Buffer.from(
        JSON.stringify({
          sub: "opaque",
          ...(malicious ? { roles: ["webpubsub.sendToGroup"] } : {}),
        }),
      ).toString("base64url");
      return route.fulfill({
        json: {
          url: `wss://fixture.webpubsub.azure.com/client/hubs/visualsprint_notifications?access_token=e30.${payload}.c2ln`,
          expiresAt: new Date(Date.now() + 120000).toISOString(),
        },
      });
    }
    if (path.endsWith("/notification-preferences")) {
      state.preferencesReads++;
      return route.fulfill({
        json: {
          workspaceId: path.split("/")[4],
          userId: "33333333-3333-4333-8333-333333333333",
          version: 0,
          inApp: true,
          email: false,
          deliveryHourUtc: null,
        },
      });
    }
    if (path.endsWith("/notifications")) {
      state.reads++;
      if (state.revoked) return route.fulfill({ status: 403, json: { code: "FORBIDDEN" } });
      return route.fulfill({ json: { items: [], nextCursor: null } });
    }
    return route.fulfill({ status: 404, json: { code: "NOT_FOUND" } });
  });
  return state;
}
async function socketCount(page: Page, closed = false) {
  return page.evaluate(
    (closed) =>
      (Reflect.get(window, "fixtureSockets") as { closed: boolean }[]).filter(
        (socket) => socket.closed === closed,
      ).length,
    closed,
  );
}
test("live hints require opt-in and only exact generic hints refetch authorized updates", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/notification-live.html");
  await expect(page.getByText("No currently authorized updates in this page.")).toBeVisible();
  expect(state.negotiations).toBe(0);
  await page.getByLabel("Enable live update hints").check();
  await expect(page.getByText(/Live hints: connected/)).toBeVisible();
  const before = state.reads;
  await page.evaluate(() => {
    const socket = (
      Reflect.get(window, "fixtureSockets") as { onmessage: (event: { data: string }) => void }[]
    )[0]!;
    socket.onmessage({ data: '{"type":"notifications.invalidate.v1","text":"private"}' });
    socket.onmessage({ data: '{"type":"notifications.invalidate.v1"}' });
    socket.onmessage({ data: '{"type":"notifications.invalidate.v1"}' });
  });
  await expect.poll(() => state.reads).toBe(before + 1);
  expect(state.negotiations).toBe(1);
  expect(await page.evaluate(() => Object.keys(localStorage).length)).toBe(0);
});
for (const action of ["Switch workspace", "Begin logout", "Close updates"])
  test(`${action} closes prior socket without a replacement`, async ({ page }) => {
    const state = await fixture(page);
    await page.goto("/notification-live.html");
    await page.getByLabel("Enable live update hints").check();
    await expect(page.getByText(/Live hints: connected/)).toBeVisible();
    await page.getByRole("button", { name: action, exact: true }).click();
    await expect.poll(() => socketCount(page, true)).toBe(1);
    expect(await socketCount(page)).toBe(0);
    expect(state.negotiations).toBe(1);
  });
for (const malicious of [false, true])
  test(`${malicious ? "role-bearing token" : "disabled service"} falls back without tight negotiation retries`, async ({
    page,
  }) => {
    const state = await fixture(page, !malicious, malicious);
    await page.clock.install();
    await page.goto("/notification-live.html");
    await page.getByLabel("Enable live update hints").check();
    await expect(page.getByText(/Live hints: fallback/)).toBeVisible();
    await page.clock.fastForward(31000);
    await expect.poll(() => state.reads).toBeGreaterThan(1);
    expect(state.negotiations).toBe(1);
    expect(await socketCount(page)).toBe(0);
  });
test("socket reconnects have a bounded backoff, then authorized polling is the fallback", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.clock.install();
  await page.goto("/notification-live.html");
  await page.getByLabel("Enable live update hints").check();
  await expect(page.getByText(/Live hints: connected/)).toBeVisible();
  for (const delay of [1100, 5100, 15100]) {
    await page.evaluate(() =>
      (Reflect.get(window, "fixtureSockets") as { onclose: (() => void) | null }[])
        .at(-1)!
        .onclose?.(),
    );
    await expect(page.getByText(/Live hints: retrying/)).toBeVisible();
    await page.clock.fastForward(delay);
    await expect(page.getByText(/Live hints: connected/)).toBeVisible();
  }
  await page.evaluate(() =>
    (Reflect.get(window, "fixtureSockets") as { onclose: (() => void) | null }[])
      .at(-1)!
      .onclose?.(),
  );
  await expect(page.getByText(/Live hints: fallback/)).toBeVisible();
  await page.clock.fastForward(31000);
  expect(state.negotiations).toBe(4);
  expect(await socketCount(page)).toBe(0);
});
test("failed authorized refresh closes live hints instead of keeping an inaccessible subscription", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/notification-live.html");
  await page.getByLabel("Enable live update hints").check();
  await expect(page.getByText(/Live hints: connected/)).toBeVisible();
  state.revoked = true;
  await page.getByRole("button", { name: "Refresh updates", exact: true }).click();
  await expect(page.getByLabel("Enable live update hints")).toBeDisabled();
  await expect.poll(() => socketCount(page, true)).toBe(1);
});
test("background notification polling does not discard unsaved channel preferences", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.clock.install();
  await page.goto("/notification-live.html");
  await expect(page.getByText("No currently authorized updates in this page.")).toBeVisible();
  await page.getByLabel("Enable generic email updates", { exact: true }).check();
  await page.clock.fastForward(31000);
  await expect.poll(() => state.reads).toBeGreaterThan(1);
  await expect(page.getByLabel("Enable generic email updates", { exact: true })).toBeChecked();
  expect(state.preferencesReads).toBe(1);
  expect(state.negotiations).toBe(0);
});
