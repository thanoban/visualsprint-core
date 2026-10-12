import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";

export const policyFacts = z
  .object({
    meetingId: id,
    ownerId: id,
    reader: z.boolean(),
    blocked: z.boolean(),
    activeMember: z.boolean(),
    relation: z.enum(["can_view", "can_manage"]),
  })
  .strict();
export type PolicyFacts = z.infer<typeof policyFacts>;

export function safeOrigin(value: string): URL {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        process.env.NODE_ENV !== "production" &&
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname)
      ))
  )
    throw new Error("INVALID_AUTHZ_ORIGIN");
  return url;
}

export class OpenFgaPolicy {
  private readonly origin: URL;
  constructor(
    origin: string,
    private readonly apiKey: string,
    private readonly storeId: string,
    private readonly modelId: string,
  ) {
    this.origin = safeOrigin(origin);
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(storeId) || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(modelId))
      throw new Error("INVALID_AUTHORIZATION_MODEL_ID");
  }
  async check(actor: Actor, input: PolicyFacts): Promise<boolean> {
    const facts = policyFacts.parse(input);
    // Request facts come exclusively from Workspace's current, RLS-protected ACL.
    // Current ACL is an upper bound: stale engine tuples cannot broaden it.
    if (
      facts.blocked ||
      !facts.activeMember ||
      (facts.ownerId !== actor.actorId && (facts.relation === "can_manage" || !facts.reader))
    )
      return false;
    const user = `user:${actor.actorId}`;
    const object = `meeting:${actor.workspaceId}/${facts.meetingId}`;
    const workspace = `workspace:${actor.workspaceId}`;
    const tuples = [
      { user: `user:${facts.ownerId}`, relation: "owner", object },
      { user: workspace, relation: "workspace", object },
      { user, relation: "member", object: workspace },
      ...(facts.reader ? [{ user, relation: "viewer", object }] : []),
    ];
    try {
      const response = await fetch(new URL(`/stores/${this.storeId}/check`, this.origin), {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          tuple_key: { user, relation: facts.relation, object },
          contextual_tuples: { tuple_keys: tuples },
          authorization_model_id: this.modelId,
          consistency: "HIGHER_CONSISTENCY",
        }),
        signal: AbortSignal.timeout(2500),
        redirect: "error",
      });
      if (!response.ok) throw new Error("POLICY_ENGINE_UNAVAILABLE");
      return z.object({ allowed: z.boolean() }).parse(await response.json()).allowed;
    } catch {
      throw new AppError("AUTHZ_UNAVAILABLE", 503);
    }
  }
}
