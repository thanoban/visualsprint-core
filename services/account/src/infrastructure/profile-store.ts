import type pg from "pg";
import { id } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";
import type { ProfileRepository, ProviderProfile } from "../application/profile-ports.js";
export class PostgresProfiles implements ProfileRepository {
  constructor(private readonly pool: pg.Pool) {}
  private async transaction<T>(actor: Actor, work: (client: pg.PoolClient) => Promise<T>) {
    id.parse(actor.actorId);
    id.parse(actor.workspaceId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.actor_id',$1,true),set_config('app.workspace_id',$2,true)",
        [actor.actorId, actor.workspaceId],
      );
      const current = (
        await client.query(
          "SELECT u.subject FROM users u JOIN memberships m ON m.user_id=u.id JOIN workspaces w ON w.id=m.workspace_id WHERE u.id=$1 AND m.workspace_id=$2 AND m.active AND NOT w.blocked",
          [actor.actorId, actor.workspaceId],
        )
      ).rows[0];
      if (!current) throw new AppError("FORBIDDEN", 403);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async begin(actor: Actor) {
    return this.transaction(actor, async (client) => {
      const owner = (await client.query("SELECT subject FROM users WHERE id=$1", [actor.actorId]))
        .rows[0];
      if (!owner) throw new AppError("NOT_FOUND", 404);
      const row = (
        await client.query(
          "INSERT INTO verified_profiles(user_id,subject,request_sequence) VALUES($1,$2,1) ON CONFLICT(user_id) DO UPDATE SET request_sequence=verified_profiles.request_sequence+1 RETURNING subject,request_sequence",
          [actor.actorId, owner.subject],
        )
      ).rows[0];
      if (row.subject !== owner.subject) throw new AppError("PROFILE_SUBJECT_CONFLICT", 409);
      return { subject: String(row.subject), sequence: Number(row.request_sequence) };
    });
  }
  async save(actor: Actor, sequence: number, profile: ProviderProfile) {
    return this.transaction(actor, async (client) => {
      const old = (
        await client.query("SELECT * FROM verified_profiles WHERE user_id=$1 FOR UPDATE", [
          actor.actorId,
        ])
      ).rows[0];
      if (!old || old.subject !== profile.subject || Number(old.request_sequence) !== sequence)
        throw new AppError("PROFILE_REFRESH_STALE", 503);
      if (profile.providerUpdatedAt && old.provider_updated_at) {
        const newer = profile.providerUpdatedAt.getTime(),
          previous = new Date(old.provider_updated_at).getTime();
        if (
          newer < previous ||
          (newer === previous && profile.verifiedEmail !== old.verified_email)
        )
          throw new AppError("PROFILE_SOURCE_REVISION_CONFLICT", 503);
      }
      await client.query(
        "UPDATE verified_profiles SET verified_email=$2,provider_updated_at=$3,applied_sequence=$4,checked_at=now() WHERE user_id=$1",
        [actor.actorId, profile.verifiedEmail, profile.providerUpdatedAt, sequence],
      );
      return { verifiedEmail: profile.verifiedEmail };
    });
  }
}
