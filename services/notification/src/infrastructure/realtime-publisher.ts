import type { DomainEvent } from "@visualsprint/contracts";
import type { RealtimePort } from "../application/ports.js";

/** At least once hints: a lost PubSub response retries the immutable bus event, never business work. */
export function realtimePublisher(
  publisher: { publish(event: DomainEvent): Promise<void> },
  realtime: RealtimePort,
) {
  return {
    async publish(event: DomainEvent) {
      await publisher.publish(event);
      if (realtime.configured && event.type === "notification.delivery.changed.v1" && event.actorId)
        await realtime.invalidate(event.workspaceId, event.actorId);
    },
  };
}
