import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import pg from "pg";

export function databasePool(connectionString: string, max = 8): pg.Pool {
  return new pg.Pool({ connectionString, max, connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000, statement_timeout: 10_000, application_name: "visualsprint-v3" });
}

export async function assertRuntimeRole(pool: pg.Pool): Promise<void> {
  const result = await pool.query<{ unsafe: boolean }>(
    `SELECT r.rolsuper OR r.rolbypassrls OR EXISTS (
       SELECT 1 FROM pg_tables t WHERE t.schemaname='public' AND t.tableowner=current_user
     ) AS unsafe FROM pg_roles r WHERE r.rolname=current_user`);
  if (result.rows[0]?.unsafe !== false) throw new Error("UNSAFE_RUNTIME_DATABASE_ROLE");
}

// Technical migration machinery only. Schemas and SQL remain in their owning service.
export async function migrate(pool: pg.Pool, directory: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(739187201)");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const name of (await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
      const source = await readFile(path.join(directory, name), "utf8");
      const checksum = createHash("sha256").update(source).digest("hex");
      const old = await client.query<{ checksum: string }>("SELECT checksum FROM schema_migrations WHERE name=$1", [name]);
      if (old.rows[0]) {
        if (old.rows[0].checksum !== checksum) throw new Error("MIGRATION_CHECKSUM_CHANGED");
        continue;
      }
      await client.query(source);
      await client.query("INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)", [name, checksum]);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
