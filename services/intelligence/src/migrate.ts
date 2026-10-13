import { fileURLToPath } from "node:url";
import { databasePool, migrate } from "@visualsprint/platform";
const url = process.env.INTELLIGENCE_MIGRATION_DATABASE_URL;
if (!url) throw new Error("MISSING_INTELLIGENCE_MIGRATION_DATABASE_URL");
const pool = databasePool(url, 1);
try {
  await migrate(pool, fileURLToPath(new URL("../migrations", import.meta.url)));
  const extended = process.env.INTELLIGENCE_EXTENDED_MIGRATIONS_ENABLED ?? "false";
  if (!["true", "false"].includes(extended)) throw new Error("INVALID_EXTENDED_MIGRATION_FLAG");
  if (extended === "true") {
    const extension = await pool.query(
      "SELECT extversion FROM pg_extension WHERE extname='vector'",
    );
    if (!extension.rows.length) throw new Error("VECTOR_OPERATOR_BOOTSTRAP_REQUIRED");
    // Explicit opt-in only. These already-qualified append-only filenames and
    // checksums are preserved; the default original database never applies them.
    await migrate(pool, fileURLToPath(new URL("../specs", import.meta.url)));
  }
} finally {
  await pool.end();
}
