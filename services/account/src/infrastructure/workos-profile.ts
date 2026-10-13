import { z } from "zod";
import { AppError, boundedJson } from "@visualsprint/platform";
import type { IdentityProfiles } from "../application/profile-ports.js";
const subject = z
  .string()
  .max(200)
  .regex(/^user_[A-Za-z0-9]+$/);
const user = z.object({
  object: z.literal("user"),
  id: subject,
  email: z.string().max(320).email(),
  email_verified: z.boolean(),
  updated_at: z.string().datetime({ offset: true }),
});
export class WorkOSProfiles implements IdentityProfiles {
  constructor(
    private readonly apiKey: string,
    private readonly transport: typeof fetch = fetch,
  ) {
    if (!/^sk_[A-Za-z0-9_-]{8,200}$/.test(apiKey)) throw new Error("INVALID_WORKOS_PROFILE_KEY");
  }
  async lookup(verifiedSubject: string) {
    if (!subject.safeParse(verifiedSubject).success)
      throw new AppError("PROFILE_SUBJECT_INVALID", 503);
    let response: Response;
    try {
      response = await this.transport(
        `https://api.workos.com/user_management/users/${verifiedSubject}`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${this.apiKey}`, accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(2000),
        },
      );
    } catch {
      throw new AppError("PROFILE_PROVIDER_UNAVAILABLE", 503);
    }
    if (response.status === 404) {
      await response.body?.cancel();
      return { subject: verifiedSubject, verifiedEmail: null, providerUpdatedAt: null };
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(
        [401, 403].includes(response.status)
          ? "PROFILE_CONFIGURATION"
          : "PROFILE_PROVIDER_UNAVAILABLE",
        503,
      );
    }
    try {
      const parsed = user.parse(await boundedJson(response, 32000));
      if (parsed.id !== verifiedSubject) throw new Error("SUBJECT_MISMATCH");
      return {
        subject: verifiedSubject,
        verifiedEmail: parsed.email_verified ? parsed.email : null,
        providerUpdatedAt: new Date(parsed.updated_at),
      };
    } catch {
      throw new AppError("PROFILE_RESPONSE_INVALID", 503);
    }
  }
}
