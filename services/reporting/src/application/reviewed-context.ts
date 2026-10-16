import { z } from "zod";
import { id } from "@visualsprint/contracts";
const version = z.number().int().positive();
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  });
export const reviewedExportRecord = z
  .object({
    id,
    meetingId: id,
    kind: z.enum(["decision", "commitment"]),
    title: z.string().min(1).max(250),
    text: z.string().min(1).max(12000),
    ownerId: id.nullable(),
    dueDate: date.nullable(),
    state: z.enum(["accepted", "superseded", "open", "completed", "cancelled"]),
    version,
    sourceMeetingVersion: version,
    citations: z
      .array(
        z
          .object({
            captureId: id,
            segmentId: id,
            revision: version,
            captureVersion: version,
            coverage: z.enum(["complete", "partial", "unknown"]),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    sourcePartial: z.boolean(),
    humanReviewed: z.literal(true),
    humanCorrected: z.boolean(),
    evidenceStatus: z.enum(["current", "changed", "unavailable"]),
    statusSource: z.literal("human_review"),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine(
    (value) =>
      value.kind === "decision"
        ? ["accepted", "superseded"].includes(value.state) &&
          value.ownerId === null &&
          value.dueDate === null
        : ["open", "completed", "cancelled"].includes(value.state),
    "Invalid reviewed record kind/state",
  )
  .refine(
    (value) =>
      new Set(value.citations.map((citation) => `${citation.captureId}:${citation.segmentId}`))
        .size === value.citations.length,
    "Duplicate evidence reference",
  );
export const reviewedAgenda = z
  .object({
    id,
    meetingId: id,
    title: z.string().min(1).max(250),
    body: z.string().min(1).max(32000),
    version,
    reviewed: z.literal(true),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export const workspaceExportContext = z
  .object({
    schemaVersion: z.literal(1),
    complete: z.literal(true),
    meetingId: id,
    meetingVersion: version,
    decisions: z.array(reviewedExportRecord).max(100),
    commitments: z.array(reviewedExportRecord).max(100),
    agendas: z.array(reviewedAgenda).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const [kind, records] of [
      ["decision", value.decisions],
      ["commitment", value.commitments],
    ] as const) {
      for (const record of records) {
        if (record.kind !== kind || record.meetingId !== value.meetingId || seen.has(record.id))
          context.addIssue({ code: "custom", message: "Reviewed record binding mismatch" });
        seen.add(record.id);
      }
    }
    for (const agenda of value.agendas) {
      if (agenda.meetingId !== value.meetingId || seen.has(agenda.id))
        context.addIssue({ code: "custom", message: "Agenda binding mismatch" });
      seen.add(agenda.id);
    }
  });
