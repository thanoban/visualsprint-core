import { z } from "zod";
import type pg from "pg";
const optional = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);
const enabled = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");
export const intelligenceFeatureConfig = z.object({
  INTELLIGENCE_PREPARATION_ENABLED: enabled,
  INTELLIGENCE_RETRIEVAL_ENABLED: enabled,
  INTELLIGENCE_MODEL_ADMISSION_ENABLED: enabled,
  INTELLIGENCE_WORKER_KIND: z
    .enum(["interactive", "preparation", "indexing"])
    .default("interactive"),
  AZURE_OPENAI_EMBEDDING_DEPLOYMENT: optional,
});
export async function installedFeatures(pool: pg.Pool) {
  const result = await pool.query<{
    vector: boolean;
    preparation: boolean;
    extension: boolean;
  }>(`SELECT
    to_regclass('public.vector_index_jobs') IS NOT NULL AS vector,
    to_regclass('public.preparation_jobs') IS NOT NULL AS preparation,
    EXISTS(SELECT 1 FROM pg_extension WHERE extname='vector') AS extension`);
  return result.rows[0]!;
}
export function validateFeatures(
  config: z.infer<typeof intelligenceFeatureConfig>,
  installed: { vector: boolean; preparation: boolean; extension: boolean },
  modelConfigured: boolean,
) {
  if (
    (config.INTELLIGENCE_PREPARATION_ENABLED ||
      config.INTELLIGENCE_RETRIEVAL_ENABLED ||
      modelConfigured) &&
    !config.INTELLIGENCE_MODEL_ADMISSION_ENABLED
  )
    throw new Error("MODEL_ADMISSION_REQUIRED");
  if (config.INTELLIGENCE_PREPARATION_ENABLED && (!installed.preparation || !modelConfigured))
    throw new Error("PREPARATION_CONFIGURATION_INCOMPLETE");
  if (
    config.INTELLIGENCE_RETRIEVAL_ENABLED &&
    (!installed.vector ||
      !installed.extension ||
      !config.AZURE_OPENAI_EMBEDDING_DEPLOYMENT ||
      !modelConfigured)
  )
    throw new Error("RETRIEVAL_CONFIGURATION_INCOMPLETE");
  if (config.INTELLIGENCE_WORKER_KIND === "preparation" && !config.INTELLIGENCE_PREPARATION_ENABLED)
    throw new Error("PREPARATION_DISABLED");
  if (config.INTELLIGENCE_WORKER_KIND === "indexing" && !config.INTELLIGENCE_RETRIEVAL_ENABLED)
    throw new Error("RETRIEVAL_DISABLED");
}
