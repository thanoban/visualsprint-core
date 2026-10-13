import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError, boundedJson, serviceToken, type Actor } from "@visualsprint/platform";
import type { DeletionParticipant, DeletionPort } from "../application/deletion-service.js";
export class HttpDeletionParticipant implements DeletionPort {
  constructor(
    private readonly name: DeletionParticipant,
    private readonly origin: string,
    private readonly key: CryptoKey,
    private readonly keyId: string,
  ) {
    const u = new URL(origin);
    if (
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== "/" ||
      (u.protocol !== "https:" &&
        !(
          process.env.NODE_ENV !== "production" &&
          u.protocol === "http:" &&
          ["127.0.0.1", "localhost"].includes(u.hostname)
        ))
    )
      throw new Error("INVALID_DELETION_ORIGIN");
  }
  async remove(
    actor: Actor,
    job: { deletionId: string; meetingId: string; sourceVersion: number },
  ) {
    const token = await serviceToken({
      caller: "workspace",
      audience: this.name,
      actor,
      privateKey: this.key,
      keyId: this.keyId,
    });
    let response: Response;
    try {
      response = await fetch(
        new URL(
          `/internal/workspaces/${actor.workspaceId}/deletions/${job.deletionId}`,
          this.origin,
        ),
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ meetingId: job.meetingId, sourceVersion: job.sourceVersion }),
          redirect: "error",
          signal: AbortSignal.timeout(4000),
        },
      );
    } catch {
      throw new AppError("DELETION_PARTICIPANT_UNAVAILABLE", 503);
    }
    if (!response.ok) throw new AppError("DELETION_PARTICIPANT_UNAVAILABLE", 503);
    const result = z
      .object({
        deletionId: id,
        meetingId: id,
        participant: z.literal(this.name),
        state: z.enum(["complete", "pending"]),
      })
      .parse(await boundedJson(response, 16000));
    if (result.deletionId !== job.deletionId || result.meetingId !== job.meetingId)
      throw new AppError("DELETION_ACK_MISMATCH", 503);
    return { state: result.state };
  }
}
