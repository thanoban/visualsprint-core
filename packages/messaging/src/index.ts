import {
  ServiceBusClient,
  type ServiceBusMessage,
  type ServiceBusReceivedMessage,
  type ServiceBusReceiver,
} from "@azure/service-bus";
import { ManagedIdentityCredential, AzureCliCredential } from "@azure/identity";
import { eventEnvelope, type DomainEvent } from "@visualsprint/contracts";
import { z } from "zod";
const entity = z.string().regex(/^[a-z][a-z0-9.-]{0,99}$/);
const namespace = z.string().regex(/^[a-z0-9][a-z0-9-]{2,48}\.servicebus\.windows\.net$/);
export function eventMessage(event: DomainEvent): ServiceBusMessage {
  const parsed = eventEnvelope.parse(event);
  return {
    body: parsed,
    messageId: parsed.eventId,
    subject: parsed.type,
    contentType: "application/json",
    correlationId: parsed.traceId,
    applicationProperties: { schemaVersion: parsed.schemaVersion, workspaceId: parsed.workspaceId },
  };
}
export function deliveryEvent(
  message: Pick<
    ServiceBusReceivedMessage,
    "body" | "messageId" | "subject" | "contentType" | "applicationProperties"
  >,
): DomainEvent {
  const parsed = eventEnvelope.parse(message.body);
  if (
    message.messageId !== parsed.eventId ||
    message.subject !== parsed.type ||
    message.contentType !== "application/json" ||
    message.applicationProperties?.workspaceId !== parsed.workspaceId ||
    message.applicationProperties?.schemaVersion !== parsed.schemaVersion
  )
    throw new Error("INVALID_EVENT_METADATA");
  return parsed;
}
type Settlement = Pick<
  ServiceBusReceiver,
  "completeMessage" | "abandonMessage" | "deadLetterMessage"
>;
export async function settleDelivery(
  receiver: Settlement,
  message: ServiceBusReceivedMessage,
  handler: (event: DomainEvent) => Promise<void>,
) {
  let event: DomainEvent;
  try {
    event = deliveryEvent(message);
  } catch {
    await receiver.deadLetterMessage(message, {
      deadLetterReason: "INVALID_EVENT_CONTRACT",
      deadLetterErrorDescription: "Message does not satisfy the versioned metadata contract",
    });
    return;
  }
  try {
    await handler(event);
  } catch {
    await receiver.abandonMessage(message);
    return;
  }
  // Handler must commit its owning inbox/effect transaction before resolving.
  // Ack failure is intentionally propagated: redelivery must be safe after commit.
  await receiver.completeMessage(message);
}
export class AzureEvents {
  private readonly client: ServiceBusClient;
  constructor(fullyQualifiedNamespace: string, identityClientId?: string) {
    namespace.parse(fullyQualifiedNamespace);
    this.client = new ServiceBusClient(
      fullyQualifiedNamespace,
      process.env.NODE_ENV === "production"
        ? new ManagedIdentityCredential(identityClientId ? { clientId: identityClientId } : {})
        : new AzureCliCredential(),
      { retryOptions: { maxRetries: 2, timeoutInMs: 8000 } },
    );
  }
  publisher(topic: string) {
    const sender = this.client.createSender(entity.parse(topic));
    return {
      publish: (event: DomainEvent) => sender.sendMessages(eventMessage(event)),
      close: () => sender.close(),
    };
  }
  subscriber(
    topic: string,
    subscription: string,
    handler: (event: DomainEvent) => Promise<void>,
    onError: () => void,
  ) {
    const receiver = this.client.createReceiver(entity.parse(topic), entity.parse(subscription), {
      receiveMode: "peekLock",
      maxAutoLockRenewalDurationInMs: 60_000,
    });
    receiver.subscribe(
      {
        processMessage: (message) => settleDelivery(receiver, message, handler),
        processError: async () => {
          onError();
        },
      },
      { autoCompleteMessages: false, maxConcurrentCalls: 5 },
    );
    return { close: () => receiver.close() };
  }
  close() {
    return this.client.close();
  }
}
