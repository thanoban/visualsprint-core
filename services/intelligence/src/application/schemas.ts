import { z } from "zod";
import { id } from "@visualsprint/contracts";
export const scope = z
  .object({ kind: z.enum(["meeting", "project", "customer", "workspace"]), id: id.nullable() })
  .strict()
  .refine(
    (value) => (value.kind === "workspace" ? value.id === null : value.id !== null),
    "Invalid scope ID",
  );
export const threadInput = z.object({ title: z.string().trim().min(1).max(200), scope }).strict();
export const summaryInput = z.object({ meetingId: id }).strict();
export const messageInput = z.object({ text: z.string().trim().min(1).max(8000) }).strict();
export const commandKey = z
  .string()
  .min(8)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/);
export const modelClaims = z
  .object({
    claims: z
      .array(
        z
          .object({
            kind: z.enum(["discussion", "decision", "commitment"]),
            text: z.string().min(1).max(4000),
            citation: z
              .object({
                meetingId: id,
                captureId: id,
                segmentId: id,
                revision: z.number().int().nonnegative(),
              })
              .strict(),
          })
          .strict(),
      )
      .max(50),
    unsupported: z.boolean(),
  })
  .strict();
