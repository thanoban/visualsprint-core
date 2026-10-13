import { AppError, type Actor } from "@visualsprint/platform";
import { fingerprint, type Scope, type Snapshot } from "../domain/evidence.js";
import { chunkEvidence, validateEmbedding } from "../domain/indexing.js";
import { commandKey, scope as scopeSchema } from "./schemas.js";
import { id } from "@visualsprint/contracts";
import type { Sources } from "./ports.js";
import type { Embeddings, VectorIndexes } from "./index-ports.js";

export class EvidenceIndexing {
  constructor(
    private readonly sources: Sources,
    private readonly indexes: VectorIndexes,
    private readonly embeddings: Embeddings,
    private readonly admission?: import("./preparation-jobs.js").ModelUsageAdmission,
  ) {}
  private async user(actor: Actor) {
    if (actor.operationGrantId) throw new AppError("FORBIDDEN", 403);
    await this.sources.requireActive(actor);
  }
  async request(actor: Actor, key: string, scope: Scope) {
    await this.user(actor);
    commandKey.parse(key);
    scopeSchema.parse(scope);
    const snapshot = await this.sources.read(actor, scope);
    const chunks = chunkEvidence(snapshot.evidence);
    return indexView(
      await this.indexes.create(actor, key, {
        scope,
        sourceFingerprint: fingerprint(snapshot),
        sourceVersions: snapshot.versions,
        totalChunks: chunks.length,
      }),
    );
  }
  async status(actor: Actor, jobId: string) {
    await this.user(actor);
    const job = await this.indexes.load(actor, id.parse(jobId));
    if (!job) throw new AppError("NOT_FOUND", 404);
    const snapshot = await this.sources.read(actor, job.scope);
    if (fingerprint(snapshot) !== job.sourceFingerprint)
      return { ...indexView(job), status: "failed", errorCode: "SOURCE_CHANGED" };
    return indexView(job);
  }
  async requireReady(actor: Actor, scope: Scope) {
    await this.user(actor);
    scopeSchema.parse(scope);
    const snapshot = await this.sources.read(actor, scope);
    if (!(await this.indexes.latest(actor, scope, fingerprint(snapshot))))
      throw new AppError("INDEX_NOT_READY", 409);
  }
  async work(workspaceId: string, jobId: string) {
    const job = await this.indexes.claim(workspaceId, jobId);
    if (!job) return;
    const actor: Actor = { workspaceId, actorId: job.ownerId, sessionId: job.sessionId };
    try {
      await this.user(actor);
      const snapshot = await this.sources.read(actor, job.scope);
      if (fingerprint(snapshot) !== job.sourceFingerprint)
        throw new AppError("SOURCE_CHANGED", 409);
      const chunks = chunkEvidence(snapshot.evidence);
      if (chunks.length !== job.totalChunks) throw new AppError("SOURCE_CHANGED", 409);
      const batch = chunks.slice(job.cursor, job.cursor + 16);
      const vectors = batch.length
        ? await this.meteredEmbed(
            actor,
            batch.map((row) => row.text),
            job.id,
            `index:${job.cursor}`,
            "indexing",
            async () => {
              if (fingerprint(await this.sources.read(actor, job.scope)) !== job.sourceFingerprint)
                throw new AppError("SOURCE_CHANGED", 409);
            },
          )
        : [];
      if (vectors.length !== batch.length) throw new Error("INVALID_EMBEDDING");
      vectors.forEach(validateEmbedding);
      await this.user(actor);
      if (fingerprint(await this.sources.read(actor, job.scope)) !== job.sourceFingerprint)
        throw new AppError("SOURCE_CHANGED", 409);
      await this.indexes.stage(
        job,
        batch.map((row, index) => ({ ...row, embedding: vectors[index]! })),
        job.cursor + batch.length === chunks.length,
      );
    } catch (error) {
      const code =
        error instanceof AppError
          ? error.code
          : error instanceof Error &&
              ["INVALID_EMBEDDING", "EVIDENCE_TOO_LARGE"].includes(error.message)
            ? error.message
            : "INDEX_UNAVAILABLE";
      await this.indexes.fail(job, code, error instanceof AppError && error.status >= 500);
    }
  }
  async retrieve(actor: Actor, scope: Scope, query: string, key: string) {
    await this.user(actor);
    scopeSchema.parse(scope);
    commandKey.parse(key);
    if (!query.trim() || Buffer.byteLength(query, "utf8") > 6000)
      throw new AppError("INVALID_QUERY", 400);
    const snapshot = await this.sources.read(actor, scope);
    const hash = fingerprint(snapshot);
    const current = await this.indexes.latest(actor, scope, hash);
    if (!current) throw new AppError("INDEX_NOT_READY", 409);
    const vectors = await this.meteredEmbed(
      actor,
      [query],
      actor.actorId,
      `retrieval:${key}:${scope.kind}:${scope.id}:${query}`,
      "retrieval",
      async () => {
        if (fingerprint(await this.sources.read(actor, scope)) !== hash)
          throw new AppError("SOURCE_CHANGED", 409);
      },
    );
    if (vectors.length !== 1) throw new AppError("INVALID_EMBEDDING", 502);
    validateEmbedding(vectors[0]!);
    const matches = await this.indexes.search(
      actor,
      current.id,
      snapshot.versions.map((row) => row.meetingId),
      vectors[0]!,
      query,
    );
    validateMatches(matches, snapshot);
    await this.user(actor);
    if (fingerprint(await this.sources.read(actor, scope)) !== hash)
      throw new AppError("SOURCE_CHANGED", 409);
    return {
      sourceFingerprint: hash,
      evidence: matches,
      partial: snapshot.versions.some((row) => row.coverage !== "complete"),
    };
  }
  private async meteredEmbed(
    actor: Actor,
    texts: string[],
    namespace: string,
    command: string,
    purpose: "indexing" | "retrieval",
    authorizeBeforeDispatch: () => Promise<void>,
  ) {
    if (!this.admission) throw new AppError("MODEL_ADMISSION_NOT_CONFIGURED", 503);
    const { modelOperationId } = await import("./model-usage.js");
    const reservation = await this.admission.reserve(actor, {
      operationId: modelOperationId(namespace, command),
      purpose,
      maxInputTokens: texts.reduce((total, text) => total + Buffer.byteLength(text, "utf8"), 0),
      maxOutputTokens: 0,
    });
    if (reservation.replay || reservation.state !== "held")
      throw new AppError("MODEL_RESERVATION_REPLAY", 409);
    try {
      await this.user(actor);
      await authorizeBeforeDispatch();
    } catch (error) {
      await this.admission.record(actor, reservation.reservationId, "not_started");
      throw error;
    }
    let output: number[][];
    try {
      output = await this.embeddings.embed(texts);
    } catch {
      await this.admission.record(actor, reservation.reservationId, "unknown");
      throw new AppError("MODEL_DISPATCH_UNKNOWN", 409);
    }
    await this.admission.record(actor, reservation.reservationId, "succeeded");
    return output;
  }
}
export function indexView(job: import("./index-ports.js").IndexJob) {
  return {
    id: job.id,
    scope: job.scope,
    status: job.status,
    cursor: job.cursor,
    totalChunks: job.totalChunks,
    sourceFingerprint: job.sourceFingerprint,
    errorCode: job.errorCode,
    createdAt: job.createdAt,
  };
}
export function validateMatches(matches: ReturnType<typeof chunkEvidence>, snapshot: Snapshot) {
  const authoritative = new Map(
    snapshot.evidence.map((row) => [
      `${row.meetingId}:${row.captureId}:${row.segmentId}:${row.revision}`,
      row,
    ]),
  );
  for (const match of matches) {
    const source = authoritative.get(
      `${match.meetingId}:${match.captureId}:${match.segmentId}:${match.revision}`,
    );
    if (
      !source ||
      match.characterStart < 0 ||
      match.characterEnd > source.text.length ||
      source.text.slice(match.characterStart, match.characterEnd) !== match.text
    )
      throw new AppError("INDEX_SOURCE_MISMATCH", 409);
  }
}
