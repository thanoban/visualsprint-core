import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { setTimeout as pause } from "node:timers/promises";
import { exportJWK, generateKeyPair } from "jose";

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("NO_TEST_PORT");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
test("compiled Account, Workspace and gateway entry points boot as native Node services", async () => {
  const key = await generateKeyPair("EdDSA", { extractable: true });
  const publicKey = { ...(await exportJWK(key.publicKey)), kid: "bundle-test" };
  const privateKey = await exportJWK(key.privateKey);
  const common = {
    ...process.env,
    WORKOS_CLIENT_ID: "client_test",
    WORKOS_TOKEN_ISSUER: "https://identity.example.com",
    WORKOS_TOKEN_AUDIENCE: "https://api.example.com",
    SERVICE_KEY_ID: "bundle-test",
    SERVICE_PRIVATE_JWK: JSON.stringify(privateKey),
    GATEWAY_PUBLIC_JWKS: JSON.stringify({ keys: [publicKey] }),
    SERVICE_TRUSTED_JWKS: JSON.stringify({ gateway: [publicKey], workspace: [publicKey] }),
  };
  const accountPort = await freePort();
  const workspacePort = await freePort();
  const gatewayPort = await freePort();
  const accountUrl = `http://127.0.0.1:${accountPort}`;
  const configurations = [
    {
      service: "account",
      port: accountPort,
      env: {
        ACCOUNT_DATABASE_URL:
          "postgres://vs_account_runtime:local-runtime-only@127.0.0.1:55434/account",
        DEFAULT_CELL_ID: "dev-cell",
      },
    },
    {
      service: "workspace",
      port: workspacePort,
      env: {
        WORKSPACE_DATABASE_URL:
          "postgres://vs_workspace_runtime:local-runtime-only@127.0.0.1:55433/workspace",
        ACCOUNT_INTERNAL_URL: accountUrl,
        AUTHZ_INTERNAL_URL: "http://127.0.0.1:4103",
      },
    },
    {
      service: "gateway",
      port: gatewayPort,
      env: {
        ACCOUNT_INTERNAL_URL: accountUrl,
        CELL_ROUTES: JSON.stringify({
          "dev-cell": { workspace: `http://127.0.0.1:${workspacePort}` },
        }),
      },
    },
  ];
  const children = configurations.map((configuration) => ({
    configuration,
    process: spawn(process.execPath, [`services/${configuration.service}/dist/main.mjs`], {
      cwd: process.cwd(),
      env: { ...common, ...configuration.env, PORT: String(configuration.port) },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    }),
    error: "",
  }));
  for (const child of children)
    child.process.stderr.on("data", (data) => {
      child.error = (child.error + String(data)).slice(-4000);
    });
  try {
    for (const child of children) {
      let healthy = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (child.process.exitCode !== null)
          throw new Error(
            `COMPILED_${child.configuration.service.toUpperCase()}_EXITED: ${child.error}`,
          );
        try {
          const response = await fetch(`http://127.0.0.1:${child.configuration.port}/health`, {
            signal: AbortSignal.timeout(500),
          });
          if (response.ok) {
            assert.equal(
              ((await response.json()) as { service: string }).service,
              child.configuration.service,
            );
            healthy = true;
            break;
          }
        } catch {
          /* bounded startup wait */
        }
        await pause(100);
      }
      assert.equal(healthy, true, `${child.configuration.service} failed to become healthy`);
    }
  } finally {
    for (const child of children) {
      if (child.process.exitCode === null) {
        const exited = once(child.process, "exit");
        child.process.kill();
        await exited;
      }
    }
  }
});
