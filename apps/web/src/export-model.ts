import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { agendaSchema } from "./agenda-model.js";
const positive = z.number().int().positive();
const dueDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  });
const segment = z
  .object({
    id,
    revision: positive,
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
    text: z.string().max(32000),
    speakerLabel: z.string().max(200).nullable(),
  })
  .strict()
  .refine((value) => value.endMs >= value.startMs);
const capture = z
  .object({
    id,
    version: positive,
    state: z.enum(["complete", "partial", "failed", "cancelled"]),
    coverage: z.string().max(40),
    segments: z.array(segment).max(20000),
  })
  .strict();
const reviewedRecord = z
  .object({
    id,
    meetingId: id,
    kind: z.enum(["decision", "commitment"]),
    title: z.string().min(1).max(250),
    text: z.string().min(1).max(12000),
    ownerId: id.nullable(),
    dueDate: dueDate.nullable(),
    state: z.enum(["accepted", "superseded", "open", "completed", "cancelled"]),
    version: positive,
    sourceMeetingVersion: positive,
    citations: z
      .array(
        z
          .object({
            captureId: id,
            segmentId: id,
            revision: positive,
            captureVersion: positive,
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
  .strict();
const base = {
  meetingId: id,
  version: positive,
  title: z.string().max(200),
  notes: z.string().max(32000),
  captures: z.array(capture).max(100),
};
const legacy = z.object({ schemaVersion: z.literal(1), ...base }).strict();
const current = z
  .object({
    schemaVersion: z.literal(2),
    ...base,
    reviewed: z
      .object({
        schemaVersion: z.literal(1),
        complete: z.literal(true),
        meetingId: id,
        meetingVersion: positive,
        decisions: z.array(reviewedRecord).max(100),
        commitments: z.array(reviewedRecord).max(100),
        agendas: z.array(agendaSchema).max(100),
      })
      .strict(),
    externalTaskVerification: z.literal("not_included"),
    generatedDrafts: z.literal("not_included"),
  })
  .strict();
export const exportArtifact = z
  .discriminatedUnion("schemaVersion", [legacy, current])
  .superRefine((value, context) => {
    const invalid = (message: string) => context.addIssue({ code: "custom", message });
    if (new TextEncoder().encode(JSON.stringify(value, null, 2)).byteLength > 2000000)
      invalid("Export size limit");
    if (
      value.captures.reduce((sum, capture) => sum + capture.segments.length, 0) > 20000 ||
      new Set(value.captures.map((capture) => capture.id)).size !== value.captures.length
    )
      invalid("Invalid capture manifest");
    for (const capture of value.captures)
      if (new Set(capture.segments.map((segment) => segment.id)).size !== capture.segments.length)
        invalid("Duplicate transcript segment");
    if (value.schemaVersion === 1) return;
    if (
      value.reviewed.meetingId !== value.meetingId ||
      value.reviewed.meetingVersion !== value.version
    )
      invalid("Reviewed source revision mismatch");
    const seen = new Set<string>();
    for (const [kind, records] of [
      ["decision", value.reviewed.decisions],
      ["commitment", value.reviewed.commitments],
    ] as const) {
      for (const record of records) {
        if (record.meetingId !== value.meetingId || record.kind !== kind || seen.has(record.id))
          invalid("Reviewed record source mismatch");
        seen.add(record.id);
        if (
          kind === "decision"
            ? !["accepted", "superseded"].includes(record.state) ||
              record.ownerId !== null ||
              record.dueDate !== null
            : !["open", "completed", "cancelled"].includes(record.state)
        )
          invalid("Human status mismatch");
        if (
          new Set(
            record.citations.map((reference) => `${reference.captureId}:${reference.segmentId}`),
          ).size !== record.citations.length
        )
          invalid("Duplicate reviewed citation");
        if (record.evidenceStatus === "current")
          for (const reference of record.citations) {
            const capture = value.captures.find((capture) => capture.id === reference.captureId),
              segment = capture?.segments.find((segment) => segment.id === reference.segmentId);
            if (
              !capture ||
              capture.version !== reference.captureVersion ||
              !segment ||
              segment.revision !== reference.revision
            )
              invalid("Current citation mismatch");
          }
      }
    }
    for (const agenda of value.reviewed.agendas) {
      if (agenda.meetingId !== value.meetingId || seen.has(agenda.id))
        invalid("Agenda source mismatch");
      seen.add(agenda.id);
    }
  });
