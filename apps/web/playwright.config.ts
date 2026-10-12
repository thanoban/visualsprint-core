import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/browser",
  timeout: 20_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5174",
    ...(process.env.CI ? {} : { channel: "msedge" }),
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm exec vite --config test/vite.config.ts",
    url: "http://127.0.0.1:5174",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
