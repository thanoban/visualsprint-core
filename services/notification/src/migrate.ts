import { fileURLToPath } from "node:url";
import { databasePool, migrate } from "@visualsprint/platform";
const pool = databasePool(process.env.NOTIFICATION_MIGRATION_URL ?? "", 1);
try {
  await migrate(pool, fileURLToPath(new URL("../migrations", import.meta.url)));
} finally {
  await pool.end();
}
