import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Separate test root and entry point. Production builds never include this identity fixture.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  server: { host: "127.0.0.1", port: 5174, strictPort: true },
});
