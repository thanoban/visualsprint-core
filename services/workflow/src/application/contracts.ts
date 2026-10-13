import { z } from "zod";
import { id } from "@visualsprint/contracts";
export const actionInput = z
  .object({
    connectionId: id,
    provider: z.enum(["jira", "github", "linear"]),
    destination: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9_./:-]+$/),
    payload: z
      .object({
        title: z.string().trim().min(1).max(250),
        description: z.string().max(12000),
        dueDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable(),
      })
      .strict(),
    source: z.object({
      meetingId: id,
      revision: z.number().int().positive(),
      commitment: z.object({ id, version: z.number().int().positive() }).strict().optional(),
    }).strict(),
  })
  .strict();
