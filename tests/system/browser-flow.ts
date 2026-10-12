import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

// This test uses the production product component and real service APIs. Only hosted
// identity is controlled; no API responses, permission checks or SQL are mocked.
export async function browserMeetingFlow(
  gatewayOrigin: string,
  token: string,
  workspaceId: string,
  meetingId: string,
  projectId: string,
) {
  const server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("../../apps/web/test", import.meta.url)),
    server: {
      host: "127.0.0.1",
      port: 0,
      proxy: { "/api/v3": { target: gatewayOrigin, changeOrigin: true } },
    },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("BROWSER_SERVER_UNAVAILABLE");
  const browser = await chromium.launch(process.env.CI ? {} : { channel: "msedge" });
  try {
    const page = await browser.newPage();
    await page.route("**/api/v3/**", (route) =>
      route.continue({
        headers: {
          ...route.request().headers(),
          authorization: `Bearer ${token}`,
        },
      }),
    );
    await page.goto(
      `http://127.0.0.1:${address.port}/w/${workspaceId}?projectId=${projectId}&meetingId=${meetingId}`,
    );
    await expect(page.getByRole("heading", { name: "Acme kickoff", exact: true })).toBeVisible();
    const notes = page.getByRole("textbox", { name: "Notes", exact: true });
    await notes.fill("Browser-confirmed decision: launch the customer pilot next week.");
    await page.getByRole("button", { name: "Save notes" }).click();
    await expect(notes).toHaveValue(
      "Browser-confirmed decision: launch the customer pilot next week.",
    );
    // A hard reload proves persistence, rather than an optimistic component-only update.
    await page.reload();
    await expect(notes).toHaveValue(
      "Browser-confirmed decision: launch the customer pilot next week.",
    );
    assert.equal(await page.getByRole("alert").count(), 0);
  } finally {
    await browser.close();
    await server.close();
  }
}
