import { z } from "zod";
import { AppError, boundedJson } from "@visualsprint/platform";
import type { Embeddings } from "../application/index-ports.js";
import { embeddingDimensions, validateEmbedding } from "../domain/indexing.js";

export class AzureEmbeddings implements Embeddings {
  private readonly url: URL;
  constructor(
    endpoint: string,
    private readonly deployment: string,
    private readonly token: (signal: AbortSignal) => Promise<string>,
    private readonly transport: typeof fetch = fetch,
  ) {
    const origin = new URL(endpoint);
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.port ||
      origin.search ||
      origin.hash ||
      origin.pathname !== "/" ||
      !/^[-a-z0-9]+\.openai\.azure\.com$/i.test(origin.hostname) ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(deployment)
    )
      throw new Error("INVALID_AZURE_MODEL_CONFIGURATION");
    this.url = new URL("/openai/v1/embeddings", origin);
  }
  async embed(texts: string[]) {
    if (
      !texts.length ||
      texts.length > 16 ||
      texts.some((text) => !text.length || Buffer.byteLength(text, "utf8") > 6000)
    )
      throw new AppError("INVALID_EMBEDDING_INPUT", 400);
    const signal = AbortSignal.timeout(35_000);
    let response: Response;
    try {
      const token = await this.token(signal);
      response = await this.transport(this.url, {
        method: "POST",
        redirect: "error",
        signal,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.deployment,
          input: texts,
          dimensions: embeddingDimensions,
          encoding_format: "float",
        }),
      });
    } catch {
      throw new AppError("EMBEDDING_UNAVAILABLE", 503);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(
        response.status === 429 ? "EMBEDDING_CAPACITY" : "EMBEDDING_UNAVAILABLE",
        503,
      );
    }
    try {
      const output = z
        .object({
          data: z
            .array(
              z.object({
                index: z.number().int().nonnegative(),
                embedding: z.array(z.number()).length(embeddingDimensions),
              }),
            )
            .length(texts.length),
        })
        .parse(await boundedJson(response, 1_500_000));
      const rows = output.data.sort((a, b) => a.index - b.index);
      if (rows.some((row, index) => row.index !== index)) throw new Error("INVALID_EMBEDDING");
      rows.forEach((row) => validateEmbedding(row.embedding));
      return rows.map((row) => row.embedding);
    } catch {
      throw new AppError("INVALID_EMBEDDING", 502);
    }
  }
}
