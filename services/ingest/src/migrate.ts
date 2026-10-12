import { fileURLToPath } from "node:url";
import { databasePool, migrate } from "@visualsprint/platform";
const url = process.env.INGEST_MIGRATION_DATABASE_URL;
if (!url) throw new Error("INGEST_MIGRATION_DATABASE_URL_REQUIRED");
const pool = databasePool(url, 1);
try {
  await migrate(pool, fileURLToPath(new URL("../migrations", import.meta.url)));
} finally {
  await pool.end();
}
