import { z } from "zod";
import { eventEnvelope, id, type DomainEvent } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";
import type { Authority, EmailPort, Repository, RealtimePort } from "./ports.js";
import type { Delivery } from "../domain/notification.js";
export class NotificationService {
  constructor(
    private readonly repository: Repository,
    private readonly authority: Authority,
    private readonly email: EmailPort,
    private readonly appOrigin: string,
    private readonly realtime?: RealtimePort,
  ) {
    const url = new URL(appOrigin);
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
          process.env.NODE_ENV !== "production"
        ))
    )
      throw new Error("INVALID_APP_ORIGIN");
  }
  private async user(actor: Actor) {
    if (actor.operationGrantId) throw new AppError("FORBIDDEN", 403);
    await this.authority.requireSession(actor);
  }
  async negotiate(actor: Actor) {
    await this.user(actor);
    if (!this.realtime?.configured) throw new AppError("REALTIME_NOT_CONFIGURED", 503);
    const connection = await this.realtime.negotiate(actor.workspaceId, actor.actorId);
    // Token issuance may take time. Revocation in that interval must prevent returning it.
    await this.user(actor);
    return connection;
  }
  async preferences(actor: Actor) {
    await this.user(actor);
    return this.repository.transaction(actor.workspaceId, (tx) => tx.preferences(actor.actorId));
  }
  async savePreferences(actor: Actor, key: string, body: unknown) {
    await this.user(actor);
    const input = z
      .object({
        expectedVersion: z.number().int().nonnegative(),
        inApp: z.boolean(),
        email: z.boolean(),
        deliveryHourUtc: z.number().int().min(0).max(23).nullable(),
        emailConsent: z.boolean(),
      })
      .strict()
      .parse(body);
    if (input.email && !input.emailConsent) throw new AppError("EMAIL_CONSENT_REQUIRED", 400);
    return this.repository.transaction(actor.workspaceId, (tx) =>
      tx.savePreferences(actor.actorId, key, input.expectedVersion, input),
    );
  }
  async receive(input: unknown) {
    const event = eventEnvelope.parse(input);
    await this.repository.transaction(event.workspaceId, (tx) => tx.consume(event));
  }
  async list(actor: Actor, after?: string) {
    await this.user(actor);
    const rows = await this.repository.transaction(actor.workspaceId, (tx) =>
      tx.list(actor.actorId, after ? id.parse(after) : undefined),
    );
    const allowed: Delivery[] = [];
    for (let offset = 0; offset < rows.length; offset += 8) {
      const batch = await Promise.all(
        rows.slice(offset, offset + 8).map(async (delivery) => {
          try {
            await this.authority.source(
              actor.workspaceId,
              actor.actorId,
              delivery.meetingId,
              delivery.id,
            );
            return delivery;
          } catch (error) {
            if (error instanceof AppError && [401, 403, 404].includes(error.status)) return null;
            throw error;
          }
        }),
      );
      allowed.push(...batch.filter((row): row is Delivery => row !== null));
    }
    return { items: allowed.map(view), nextCursor: rows.length === 50 ? rows.at(-1)!.id : null };
  }
  async markRead(actor: Actor, deliveryId: string, body: unknown) {
    await this.user(actor);
    const input = z.object({ expectedVersion: z.number().int().positive() }).strict().parse(body);
    const current = await this.repository.transaction(actor.workspaceId, (tx) =>
      tx.delivery(deliveryId, actor.actorId),
    );
    await this.authority.source(actor.workspaceId, actor.actorId, current.meetingId, current.id);
    return view(
      await this.repository.transaction(actor.workspaceId, (tx) =>
        tx.markRead(deliveryId, actor.actorId, input.expectedVersion),
      ),
    );
  }
  async work(workspaceId: string, deliveryId: string) {
    const delivery = await this.repository.transaction(workspaceId, (tx) => tx.claim(deliveryId));
    if (!delivery) return;
    let sideEffectPossible = false;
    const finish = (
      state: Delivery["state"],
      code: string | null = null,
      externalId: string | null = null,
    ) =>
      this.repository.transaction(workspaceId, (tx) =>
        tx.finish(delivery, state, code, externalId),
      );
    try {
      if (delivery.channel === "email" && delivery.errorCode === "RECONCILE") {
        sideEffectPossible = true;
        const result = await this.email.lookup(delivery.id);
        if (result.state === "sent") return finish("provider_sent", null, result.externalId);
        if (result.state === "rejected") return finish("failed", result.code);
        if (result.state === "not_sent") return finish("queued");
        return finish("unknown", "EMAIL_RESPONSE_UNKNOWN");
      }
      const preference = await this.repository.transaction(workspaceId, (tx) =>
        tx.preferences(delivery.userId),
      );
      if (delivery.channel === "email" ? !preference.email : !preference.inApp)
        return finish("cancelled", "PREFERENCE_DISABLED");
      const profile = await this.authority.profile(workspaceId, delivery.userId, delivery.id);
      await this.authority.source(workspaceId, delivery.userId, delivery.meetingId, delivery.id);
      if (delivery.channel === "in_app") return finish("delivered");
      if (!this.email.configured) return finish("held", "EMAIL_NOT_CONFIGURED");
      if (!profile.verifiedEmail) return finish("held", "VERIFIED_EMAIL_REQUIRED");
      await this.email.prepare?.();
      const currentPreference = await this.repository.transaction(workspaceId, (tx) =>
        tx.preferences(delivery.userId),
      );
      if (!currentPreference.email) return finish("cancelled", "PREFERENCE_DISABLED");
      const currentProfile = await this.authority.profile(
        workspaceId,
        delivery.userId,
        delivery.id,
      );
      await this.authority.source(workspaceId, delivery.userId, delivery.meetingId, delivery.id);
      if (!currentProfile.verifiedEmail) return finish("held", "VERIFIED_EMAIL_REQUIRED");
      // Never include meeting title, customer, project, transcript, task text or provider join links in email.
      const appUrl = new URL(`/w/${workspaceId}`, this.appOrigin).toString();
      await this.repository.transaction(workspaceId, (tx) => tx.startEmail(delivery));
      sideEffectPossible = true;
      const result = await this.email.send({
        deliveryId: delivery.id,
        to: currentProfile.verifiedEmail,
        subject: "Your VisualSprint update is ready",
        text: `An update is ready in your VisualSprint workspace. Open ${appUrl}`,
      });
      if (result.state === "sent") return finish("provider_sent", null, result.externalId);
      if (result.state === "rejected") return finish("failed", result.code);
      return finish("unknown", "EMAIL_RESPONSE_UNKNOWN");
    } catch (error) {
      if (error instanceof AppError && error.code === "STALE_WORKER") return;
      if (sideEffectPossible) return finish("unknown", "EMAIL_RESPONSE_UNKNOWN");
      if (error instanceof AppError && [401, 403, 404].includes(error.status))
        return finish("held", "SOURCE_ACCESS_REVOKED");
      return finish(
        sideEffectPossible ? "unknown" : "held",
        sideEffectPossible ? "EMAIL_RESPONSE_UNKNOWN" : "SOURCE_UNAVAILABLE",
      );
    }
  }
  async deleteMeeting(actor: Actor, deletionId: string, body: unknown) {
    const input = z
      .object({ meetingId: id, sourceVersion: z.number().int().positive() })
      .strict()
      .parse(body);
    await this.repository.transaction(actor.workspaceId, (tx) =>
      tx.deleteMeeting(deletionId, input.meetingId, input.sourceVersion),
    );
    return {
      deletionId,
      meetingId: input.meetingId,
      participant: "notification",
      state: "complete" as const,
    };
  }
}
export function view(delivery: Delivery) {
  return {
    id: delivery.id,
    meetingId: delivery.meetingId,
    kind: delivery.kind,
    channel: delivery.channel,
    state: delivery.state,
    version: delivery.version,
    availableAt: delivery.availableAt.toISOString(),
    readAt: delivery.readAt?.toISOString() ?? null,
    errorCode: delivery.errorCode,
  };
}
export function authorizedEvent(caller: string, event: DomainEvent) {
  return (
    (caller === "intelligence" && event.type === "summary.ready.v1") ||
    (caller === "workflow" && event.type === "action.completed.v1") ||
    (caller === "ingest" && event.type === "capture.state.changed.v1")
  );
}
