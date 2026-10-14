import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("dist");
const port = Number(process.env.PORT ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("INVALID_PORT");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".woff2": "font/woff2" };
const server = http.createServer(async (request, response) => {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("cache-control", "no-store");
  const finish = code => { response.statusCode = code; response.end(); };
  if (!["GET", "HEAD"].includes(request.method)) return finish(405);
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://static.invalid").pathname);
    if (pathname === "/health") { response.setHeader("content-type", "application/json"); response.end(request.method === "HEAD" ? undefined : '{"status":"ok","service":"web"}'); return; }
    if (pathname.startsWith("/api/") || pathname.startsWith("/webhooks/")) return finish(404);
    if (pathname.includes("\0") || pathname.includes("\\")) return finish(400);
    if (pathname.split("/").some(part => part.startsWith("."))) return finish(404);
    let file = path.resolve(root, "." + pathname);
    if (file === root) file = path.join(root, "index.html");
    else if (!file.startsWith(root + path.sep)) return finish(404);
    let info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      if (path.extname(pathname)) return finish(404);
      file = path.join(root, "index.html"); info = await stat(file);
    }
    const type = types[path.extname(file)];
    if (!type) return finish(404);
    response.setHeader("content-type", type);
    response.setHeader("content-length", info.size);
    if (pathname.startsWith("/assets/")) response.setHeader("cache-control", "public, max-age=31536000, immutable");
    if (request.method === "HEAD") return response.end();
    createReadStream(file).on("error", () => response.destroy()).pipe(response);
  } catch { finish(400); }
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.listen(port, "0.0.0.0");
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => server.close());
