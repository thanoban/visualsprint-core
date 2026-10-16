import { z } from "zod";
import { id } from "@visualsprint/contracts";
export const agendaSchema = z
  .object({
    id,
    meetingId: id,
    title: z.string().min(1).max(250),
    body: z.string().min(1).max(32000),
    version: z.number().int().positive(),
    reviewed: z.literal(true),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export const agendaContent = z
  .object({
    title: z.string().trim().min(1).max(250),
    body: z.string().trim().min(1).max(32000),
    expectedMeetingVersion: z.number().int().positive(),
    confirmed: z.literal(true),
  })
  .strict();
export const agendaCorrection = agendaContent
  .extend({ expectedVersion: z.number().int().positive() })
  .strict();
export const agendaDeletion = z
  .object({
    expectedMeetingVersion: z.number().int().positive(),
    expectedVersion: z.number().int().positive(),
    confirmed: z.literal(true),
  })
  .strict();
export const agendaDeleted = z
  .object({ id, meetingId: id, deleted: z.literal(true), version: z.number().int().positive() })
  .strict();
export type Agenda = z.infer<typeof agendaSchema>;
