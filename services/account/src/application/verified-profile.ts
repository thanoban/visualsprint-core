import { AppError, type Actor } from "@visualsprint/platform";
import type { IdentityProfiles, NotificationProfiles, ProfileRepository } from "./profile-ports.js";
export class VerifiedProfileService implements NotificationProfiles {
  constructor(
    private readonly repository: ProfileRepository,
    private readonly provider: IdentityProfiles,
  ) {}
  async forActor(actor: Actor) {
    if (actor.operationGrantId) throw new AppError("FORBIDDEN", 403);
    const intent = await this.repository.begin(actor);
    const profile = await this.provider.lookup(intent.subject);
    if (profile.subject !== intent.subject) throw new AppError("PROFILE_RESPONSE_INVALID", 503);
    return this.repository.save(actor, intent.sequence, profile);
  }
}
