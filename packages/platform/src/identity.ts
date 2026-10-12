import { randomUUID } from "node:crypto";
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  decodeJwt,
  jwtVerify,
  SignJWT,
  type JWK,
  type JWTVerifyGetKey,
} from "jose";
import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError } from "./errors.js";

export const delegatedActor = z
  .object({
    actorId: id,
    sessionId: z.string().min(1).max(200),
    workspaceId: id,
    operationGrantId: id.optional(),
  })
  .strict()
  .superRefine((actor, context) => {
    if (
      actor.operationGrantId
        ? actor.sessionId !== `operation:${actor.operationGrantId}`
        : actor.sessionId.startsWith("operation:")
    )
      context.addIssue({ code: "custom", message: "Invalid operation principal" });
  });
export type Actor = z.infer<typeof delegatedActor>;
export type Identity = { subject: string; sessionId: string };

export function bearer(header: string | undefined): string {
  const match = header?.match(/^Bearer ([A-Za-z0-9._~-]+)$/);
  if (!match?.[1] || match[1].length > 16_384) throw new AppError("UNAUTHENTICATED", 401);
  return match[1];
}

export class WorkOSVerifier {
  private readonly keys: JWTVerifyGetKey;
  constructor(
    private readonly config: { clientId: string; issuer: string; audience: string },
    keys?: JWTVerifyGetKey,
  ) {
    if (!config.clientId || !config.audience || !config.issuer.startsWith("https://")) {
      throw new Error("INVALID_WORKOS_CONFIGURATION");
    }
    this.keys =
      keys ??
      createRemoteJWKSet(
        new URL(`https://api.workos.com/sso/jwks/${encodeURIComponent(config.clientId)}`),
        { timeoutDuration: 5000 },
      );
  }
  async verify(token: string): Promise<Identity> {
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: ["RS256"],
        requiredClaims: ["exp", "iat", "sub", "sid", "client_id"],
        clockTolerance: 5,
      });
      if (
        payload.client_id !== this.config.clientId ||
        typeof payload.sub !== "string" ||
        !payload.sub.startsWith("user_") ||
        typeof payload.sid !== "string" ||
        !payload.sid
      ) {
        throw new AppError("UNAUTHENTICATED", 401);
      }
      return { subject: payload.sub, sessionId: payload.sid };
    } catch (error) {
      if (error instanceof AppError) throw error;
      const code =
        typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      const badToken =
        code.startsWith("ERR_JWT_") ||
        code.startsWith("ERR_JWS_") ||
        code === "ERR_JWKS_NO_MATCHING_KEY";
      throw new AppError(
        badToken ? "UNAUTHENTICATED" : "IDENTITY_UNAVAILABLE",
        badToken ? 401 : 503,
      );
    }
  }
}

export class ServiceIdentity {
  private readonly issuers: Map<string, JWTVerifyGetKey>;
  constructor(
    private readonly audience: string,
    publicKeysByIssuer: Record<string, JWK[]>,
  ) {
    this.issuers = new Map(
      Object.entries(publicKeysByIssuer).map(([issuer, keys]) => [
        issuer,
        createLocalJWKSet({ keys }),
      ]),
    );
  }
  private async payload(token: string) {
    try {
      // Unverified issuer selects a pinned key set; verification establishes trust.
      const issuer = decodeJwt(token).iss;
      const keys = issuer ? this.issuers.get(issuer) : undefined;
      if (!issuer || !keys) throw new Error("UNKNOWN_CALLER");
      const { payload } = await jwtVerify(token, keys, {
        audience: this.audience,
        issuer,
        algorithms: ["EdDSA"],
        requiredClaims: ["exp", "iat", "jti", "sub"],
        maxTokenAge: "30s",
      });
      if (payload.sub !== payload.iss || !payload.iss) throw new Error("INVALID_CALLER");
      return payload;
    } catch {
      throw new AppError("UNAUTHENTICATED_SERVICE", 401);
    }
  }
  async verify(token: string): Promise<{ caller: string; actor: Actor }> {
    const payload = await this.payload(token);
    try {
      return { caller: payload.iss!, actor: delegatedActor.parse(payload.actor) };
    } catch {
      throw new AppError("UNAUTHENTICATED_SERVICE", 401);
    }
  }
  async verifyIdentity(token: string): Promise<{ caller: string; identity: Identity }> {
    const payload = await this.payload(token);
    try {
      return {
        caller: payload.iss!,
        identity: z
          .object({
            subject: z.string().regex(/^user_[A-Za-z0-9]+$/),
            sessionId: z.string().min(1).max(200),
          })
          .strict()
          .parse(payload.identity),
      };
    } catch {
      throw new AppError("UNAUTHENTICATED_SERVICE", 401);
    }
  }
}

export function serviceToken(input: {
  caller: string;
  audience: string;
  actor: Actor;
  keyId: string;
  privateKey: CryptoKey;
}): Promise<string> {
  return new SignJWT({ actor: delegatedActor.parse(input.actor) })
    .setProtectedHeader({ alg: "EdDSA", kid: input.keyId })
    .setSubject(input.caller)
    .setIssuer(input.caller)
    .setAudience(input.audience)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime("30s")
    .sign(input.privateKey);
}

export function identityToken(input: {
  caller: string;
  audience: string;
  identity: Identity;
  keyId: string;
  privateKey: CryptoKey;
}): Promise<string> {
  return new SignJWT({ identity: input.identity })
    .setProtectedHeader({ alg: "EdDSA", kid: input.keyId })
    .setSubject(input.caller)
    .setIssuer(input.caller)
    .setAudience(input.audience)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime("30s")
    .sign(input.privateKey);
}
