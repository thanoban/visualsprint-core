import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api/v3": { target: "http://127.0.0.1:4100", changeOrigin: true } },
  },
  build: { sourcemap: false },
});
