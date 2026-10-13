import type pg from "pg";
import { VerifiedProfileService } from "../application/verified-profile.js";
import { PostgresProfiles } from "./profile-store.js";
import { WorkOSProfiles } from "./workos-profile.js";
import type { NotificationProfiles } from "../application/profile-ports.js";
export function configuredProfiles(
  pool: pg.Pool,
  serverApiKey?: string,
): NotificationProfiles | undefined {
  return serverApiKey
    ? new VerifiedProfileService(new PostgresProfiles(pool), new WorkOSProfiles(serverApiKey))
    : undefined;
}
