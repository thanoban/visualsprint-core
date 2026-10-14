import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const enabled = process.env.AZURE_BOOTSTRAP_TEST_ENABLED === "true";
test(
  "private database role bootstrap with non-superuser administrator and replay fences",
  { skip: !enabled, timeout: 60000 },
  async () => {
    const name = `vs-azure-bootstrap-${randomUUID().slice(0, 8)}`;
    const localPassword = "local-qualification-password-only-not-production";
    const docker = (args, input) =>
      execFileSync("docker", args, {
        input,
        encoding: "utf8",
        windowsHide: true,
        timeout: 15000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    // --pull=never makes a missing local fixture image a failure, not a network download.
    const id = docker([
      "run",
      "--pull=never",
      "-d",
      "--name",
      name,
      "--label",
      "visualsprint.qualification=azure-bootstrap",
      "-e",
      `POSTGRES_PASSWORD=${localPassword}`,
      "postgres:17.6-alpine",
    ]);
    assert.match(id, /^[a-f0-9]{64}$/);
    try {
      for (let i = 0; i < 30; i++) {
        try {
          docker(["exec", id, "pg_isready", "-U", "postgres"]);
          break;
        } catch {
          if (i === 29) throw new Error("POSTGRES_NOT_READY");
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      const sql = (user, text, env = []) =>
        docker(
          [
            "exec",
            "-i",
            ...env.flatMap(([key, value]) => ["-e", `${key}=${value}`]),
            id,
            "psql",
            "-X",
            "-U",
            user,
            "-d",
            "postgres",
            "-v",
            "ON_ERROR_STOP=1",
            "-f",
            "-",
          ],
          text,
        );
      sql(
        "postgres",
        `CREATE ROLE vs_provisioner LOGIN CREATEROLE CREATEDB NOSUPERUSER NOBYPASSRLS NOINHERIT;\nCREATE DATABASE workspace OWNER vs_provisioner;\nCREATE DATABASE authz_application OWNER vs_provisioner;\n`,
      );
      const source = readFileSync(new URL("../bootstrap/bootstrap.sql", import.meta.url), "utf8");
      const env = [
        ["DB_NAME", "workspace"],
        ["MIGRATION_PASSWORD", "migration-fixture-" + "m".repeat(32)],
        ["RUNTIME_PASSWORD", "runtime-fixture-" + "r".repeat(32)],
      ];
      assert.match(sql("vs_provisioner", source, env), /BOOTSTRAP_ROLES_COMPLETE/);
      assert.match(sql("vs_provisioner", source, env), /BOOTSTRAP_ROLES_COMPLETE/);
      const rows = sql(
        "postgres",
        `SELECT rolname,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolinherit FROM pg_roles WHERE rolname='vs_workspace_runtime';\n`,
      );
      assert.match(rows, /vs_workspace_runtime\s+\| f\s+\| f\s+\| f\s+\| f\s+\| f/);
      assert.throws(() =>
        sql("vs_workspace_runtime", `\connect workspace\nCREATE TABLE forbidden(id int);\n`),
      );
      assert.throws(() =>
        sql("vs_workspace_runtime", `\connect workspace\nSET ROLE vs_workspace_migration;\n`),
      );
      assert.throws(() =>
        sql("vs_provisioner", source, [
          ...env.filter(([key]) => key !== "DB_NAME"),
          ["DB_NAME", "evil; DROP DATABASE workspace;"],
        ]),
      );
      sql("postgres", "ALTER ROLE vs_workspace_runtime BYPASSRLS;\n");
      assert.throws(() => sql("vs_provisioner", source, env));
      assert.match(
        sql("vs_provisioner", source, [
          ...env.filter(([key]) => key !== "DB_NAME"),
          ["DB_NAME", "authz_application"],
        ]),
        /BOOTSTRAP_ROLES_COMPLETE/,
      );
      assert.match(
        sql("postgres", `SELECT rolname FROM pg_roles WHERE rolname='vs_authz_app_runtime';\n`),
        /vs_authz_app_runtime/,
      );
    } finally {
      assert.equal(
        docker([
          "inspect",
          id,
          "--format",
          '{{index .Config.Labels "visualsprint.qualification"}}',
        ]),
        "azure-bootstrap",
      );
      docker(["rm", "-f", id]);
    }
  },
);
