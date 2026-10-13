import { z } from "zod";
import { id } from "@visualsprint/contracts";
import type { Actor } from "@visualsprint/platform";
export interface MeetingDeletionBarrier {
  blocked(workspaceId: string, meetingId: string): Promise<boolean>;
}
export interface AuthzDeletionRepository extends MeetingDeletionBarrier {
  begin(
    workspaceId: string,
    deletionId: string,
    meetingId: string,
    sourceVersion: number,
  ): Promise<{ completed: boolean }>;
  complete(workspaceId: string, deletionId: string): Promise<void>;
}
export interface MeetingTuplePurge {
  remove(workspaceId: string, meetingId: string): Promise<void>;
}
export class AuthzDeletionService {
  constructor(
    private readonly repository: AuthzDeletionRepository,
    private readonly tuples: MeetingTuplePurge,
  ) {}
  async delete(actor: Actor, deletionId: string, body: unknown) {
    const input = z
      .object({ meetingId: id, sourceVersion: z.number().int().positive() })
      .strict()
      .parse(body);
    id.parse(actor.workspaceId);
    id.parse(deletionId);
    await this.repository.begin(
      actor.workspaceId,
      deletionId,
      input.meetingId,
      input.sourceVersion,
    );
    let state: "pending" | "complete" = "pending";
    try {
      await this.tuples.remove(actor.workspaceId, input.meetingId);
      await this.repository.complete(actor.workspaceId, deletionId);
      state = "complete";
    } catch {
      /* Persisted deny barrier precedes remote cleanup; Workspace durably retries pending acknowledgements. */
    }
    return { deletionId, meetingId: input.meetingId, participant: "authz" as const, state };
  }
}
