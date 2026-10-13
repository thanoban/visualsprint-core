import { id } from "@visualsprint/contracts";
import { z } from "zod";
export const exportInput = z
  .object({ meetingId: id, format: z.enum(["text", "json"]).default("text") })
  .strict();
export const deletionInput = z
  .object({ meetingId: id, sourceVersion: z.number().int().positive() })
  .strict();
