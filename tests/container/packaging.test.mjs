import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";

function docker(args, env = process.env) {
  const result = spawnSync("docker", args, { encoding: "utf8", env, timeout: 30000 });
  if (result.error || result.status !== 0) throw new Error(`Docker command failed: ${args[0]}`);
  return result.stdout.trim();
}
test("web image serves SPA and assets without exposing APIs, source or private paths", async () => {
  const image = process.env.WEB_PACKAGING_TEST_IMAGE ?? "visualsprint-v3-web:local";
  docker(["run", "--rm", "--entrypoint", "node", image, "-e",
    "const fs=require('node:fs');const assert=require('node:assert/strict');assert.notEqual(process.getuid(),0);assert.ok(fs.existsSync('dist/index.html'));for(const p of ['src','test','.env','node_modules'])assert.equal(fs.existsSync(p),false);"]);
  const name = `visualsprint-v3-web-packaging-${randomUUID()}`;
  docker(["run", "--detach", "--rm", "--name", name, "-p", "127.0.0.1::8080", image]);
  try {
    const port = docker(["port", name, "8080/tcp"]).match(/^127\.0\.0\.1:(\d+)$/)?.[1];
    assert.ok(port);
    const origin = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { ready = (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
      if (ready) break; await setTimeout(250);
    }
    assert.equal(ready, true);
    const page = await fetch(`${origin}/w/test-workspace`);
    assert.equal(page.status, 200); assert.match(page.headers.get("content-type"), /text\/html/);
    assert.equal(page.headers.get("cache-control"), "no-store");
    const html = await page.text();
    const asset = html.match(/src="(\/assets\/[^" ]+\.js)"/)?.[1];
    assert.ok(asset); const script = await fetch(origin + asset);
    assert.equal(script.status, 200); assert.match(script.headers.get("content-type"), /javascript/);
    for (const target of ["/api/v3/me", "/webhooks/v3/recall", "/.env", "/..%2fweb-server.mjs", "/assets/missing.js"])
      assert.equal((await fetch(origin + target)).status, 404, target);
    assert.equal((await fetch(origin, { method: "POST", body: "ignored" })).status, 405);
  } finally { docker(["stop", "--time", "5", name]); }
});

test("gateway image is non-root, excludes source and boots with runtime-only fixture configuration", async () => {
  const image = process.env.PACKAGING_TEST_IMAGE ?? "visualsprint-v3-gateway:local";
  docker(["run", "--rm", "--entrypoint", "node", image, "-e",
    "const fs=require('node:fs');const assert=require('node:assert/strict');assert.notEqual(process.getuid(),0);assert.ok(fs.existsSync('dist/main.mjs'));for(const p of ['src','test','.env','.env.local'])assert.equal(fs.existsSync(p),false);require('fastify');"]);
  const name = `visualsprint-v3-packaging-${randomUUID()}`;
  const { privateKey } = generateKeyPairSync("ed25519");
  const env = { ...process.env,
    ACCOUNT_INTERNAL_URL: "https://account.invalid", CELL_ROUTES: "{}",
    SERVICE_PRIVATE_JWK: JSON.stringify(privateKey.export({ format: "jwk" })),
    SERVICE_KEY_ID: "packaging-fixture", WORKOS_CLIENT_ID: "client_packaging_fixture",
    WORKOS_TOKEN_ISSUER: "https://identity.invalid", WORKOS_TOKEN_AUDIENCE: "https://api.invalid",
  };
  const configNames = ["ACCOUNT_INTERNAL_URL", "CELL_ROUTES", "SERVICE_PRIVATE_JWK", "SERVICE_KEY_ID",
    "WORKOS_CLIENT_ID", "WORKOS_TOKEN_ISSUER", "WORKOS_TOKEN_AUDIENCE"];
  docker(["run", "--detach", "--rm", "--name", name, "-p", "127.0.0.1::8080",
    ...configNames.flatMap(key => ["-e", key]), image], env);
  try {
    const port = docker(["port", name, "8080/tcp"]).match(/^127\.0\.0\.1:(\d+)$/)?.[1];
    assert.ok(port);
    let healthy = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) { assert.deepEqual(await response.json(), { status: "ok", service: "gateway" }); healthy = true; break; }
      } catch { /* bounded startup retry, never retries a side effect */ }
      await setTimeout(250);
    }
    assert.equal(healthy, true, "gateway did not become healthy");
  } finally {
    // Only this test's explicitly named temporary container is stopped.
    docker(["stop", "--time", "5", name]);
  }
});
