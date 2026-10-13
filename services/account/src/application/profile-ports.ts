import type { Actor } from "@visualsprint/platform";
export interface ProviderProfile {
  subject: string;
  verifiedEmail: string | null;
  providerUpdatedAt: Date | null;
}
export interface IdentityProfiles {
  lookup(subject: string): Promise<ProviderProfile>;
}
export interface ProfileRepository {
  begin(actor: Actor): Promise<{ subject: string; sequence: number }>;
  save(
    actor: Actor,
    sequence: number,
    profile: ProviderProfile,
  ): Promise<{ verifiedEmail: string | null }>;
}
// This adapter is Account-owned: Notification never reads WorkOS or the Account database itself.
export interface NotificationProfiles {
  forActor(actor: Actor): Promise<{ verifiedEmail: string | null }>;
}
