import { z } from "zod";

export const id = z.string().uuid();
export const captureState = z.enum([
  "scheduled",
  "dispatching",
  "dispatch_unknown",
  "joining",
  "waiting_for_admission",
  "capturing",
  "stopping",
  "finalizing",
  "complete",
  "partial",
  "failed",
  "cancelled",
]);
export type CaptureState = z.infer<typeof captureState>;

export const captureError = z.enum([
  "HOST_DENIED",
  "HOST_REMOVED",
  "POLICY_BLOCKED",
  "INVALID_LINK",
  "PROVIDER_CAPACITY",
  "DISPATCH_UNKNOWN",
  "PROVIDER_UNAVAILABLE",
  "CAPTURE_GAP",
  "REAUTH_REQUIRED",
  "UNKNOWN_PROVIDER_STATE",
]);

export const eventTypes = [
  "workspace.created.v1",
  "membership.changed.v1",
  "usage.reserved.v1",
  "usage.settled.v1",
  "usage.released.v1",
  "customer.created.v1",
  "project.created.v1",
  "meeting.updated.v1",
  "calendar.occurrence.changed.v1",
  "meeting.created.v1",
  "meeting.access.changed.v1",
  "meeting.assignment.confirmed.v1",
  "capture.requested.v1",
  "capture.state.changed.v1",
  "transcript.revision.changed.v1",
  "transcript.finalized.v1",
  "summary.ready.v1",
  "proposal.confirmed.v1",
  "action.approved.v1",
  "action.completed.v1",
  "action.reconciliation.required.v1",
  "deletion.requested.v1",
  "deletion.acknowledged.v1",
] as const;

// Content is fetched from its owning service using authorization. Bus messages
// deliberately have no arbitrary payload field for transcript or credential data.
export const eventEnvelope = z
  .object({
    eventId: id,
    type: z.enum(eventTypes),
    schemaVersion: z.literal(1),
    workspaceId: id,
    aggregateId: id,
    aggregateVersion: z.number().int().positive(),
    occurredAt: z.string().datetime(),
    traceId: z.string().regex(/^[a-f0-9]{32}$/),
    actorId: id.nullable(),
    references: z
      .array(
        z
          .object({
            kind: z.enum([
              "customer",
              "project",
              "meeting",
              "capture",
              "transcript",
              "occurrence",
              "proposal",
              "action",
              "deletion",
            ]),
            id,
            revision: z.number().int().nonnegative().optional(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
export type DomainEvent = z.infer<typeof eventEnvelope>;

export const confirmedAssignment = z
  .object({
    meetingId: id,
    projectId: id,
    expectedVersion: z.number().int().positive(),
    confirmed: z.literal(true),
  })
  .strict();

export const transcriptSegment = z
  .object({
    sourceSegmentId: z.string().min(1).max(200),
    sourceRevision: z.number().int().nonnegative(),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
    text: z.string().min(1).max(32_000),
    speakerLabel: z.string().max(200).nullable(),
    final: z.boolean(),
  })
  .strict()
  .refine((segment) => segment.endMs >= segment.startMs, "Invalid segment interval");

export const asynchronousOperation = z
  .object({
    operationId: id,
    resourceId: id,
    status: z.literal("accepted"),
  })
  .strict();
