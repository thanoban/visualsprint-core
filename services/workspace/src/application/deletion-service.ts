import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";
export const deletionParticipants = [
  "ingest",
  "intelligence",
  "reporting",
  "workflow",
  "integration",
  "notification",
  "authz",
] as const;
export type DeletionParticipant = (typeof deletionParticipants)[number];
export type DeletionJob = {
  workspaceId: string;
  id: string;
  meetingId: string;
  ownerId: string;
  sessionId: string;
  sourceVersion: number;
  state: "pending" | "complete";
  required: DeletionParticipant[];
  acknowledgements: Partial<Record<DeletionParticipant, "complete">>;
  leaseToken: string | null;
};
export interface DeletionRepository {
  request(
    actor: Actor,
    key: string,
    input: { meetingId: string; expectedVersion: number },
    required: DeletionParticipant[],
  ): Promise<DeletionJob>;
  existing(ws: string, meetingId: string): Promise<DeletionJob | undefined>;
  get(ws: string, jobId: string): Promise<DeletionJob | undefined>;
  claim(ws: string, jobId: string): Promise<DeletionJob | undefined>;
  ack(job: DeletionJob, participant: DeletionParticipant): Promise<void>;
  release(job: DeletionJob): Promise<void>;
  due(): Promise<{ workspaceId: string; id: string }[]>;
}
export interface DeletionAuthority {
  active(actor: Actor): Promise<void>;
  manage(actor: Actor, meetingId: string): Promise<void>;
}
export interface DeletionPort {
  remove(
    actor: Actor,
    job: { deletionId: string; meetingId: string; sourceVersion: number },
  ): Promise<{ state: "complete" | "pending" }>;
}
const view = (job: DeletionJob) => ({
  id: job.id,
  meetingId: job.meetingId,
  state: job.state,
  required: job.required,
  completed: job.required.filter((p) => job.acknowledgements[p] === "complete"),
});
export class DeletionService {
  constructor(
    private readonly repository: DeletionRepository,
    private readonly authority: DeletionAuthority,
    private readonly participants: Partial<Record<DeletionParticipant, DeletionPort>>,
  ) {}
  async request(actor: Actor, key: string, body: unknown) {
    if (actor.operationGrantId) throw new AppError("FORBIDDEN", 403);
    const input = z
      .object({ meetingId: id, expectedVersion: z.number().int().positive() })
      .strict()
      .parse(body);
    z.string()
      .min(8)
      .max(200)
      .regex(/^[A-Za-z0-9_.:-]+$/)
      .parse(key);
    await this.authority.active(actor);
    const existing = await this.repository.existing(actor.workspaceId, input.meetingId);
    if (!existing || existing.ownerId !== actor.actorId)
      await this.authority.manage(actor, input.meetingId);
    return view(await this.repository.request(actor, key, input, [...deletionParticipants]));
  }
  async status(actor: Actor, jobId: string) {
    if (actor.operationGrantId) throw new AppError("FORBIDDEN", 403);
    await this.authority.active(actor);
    const job = await this.repository.get(actor.workspaceId, id.parse(jobId));
    if (!job || job.ownerId !== actor.actorId) throw new AppError("NOT_FOUND", 404);
    return view(job);
  }
  async work(ws: string, jobId: string) {
    const job = await this.repository.claim(ws, jobId);
    if (!job) return;
    const actor = { workspaceId: job.workspaceId, actorId: job.ownerId, sessionId: job.sessionId };
    try {
      for (const participant of job.required) {
        if (job.acknowledgements[participant] === "complete") continue;
        const port = this.participants[participant];
        if (!port) continue;
        try {
          const result = await port.remove(actor, {
            deletionId: job.id,
            meetingId: job.meetingId,
            sourceVersion: job.sourceVersion,
          });
          if (result.state === "complete") await this.repository.ack(job, participant);
        } catch {
          /* Safe pending recovery; do not log private provider payload. */
        }
      }
    } finally {
      await this.repository.release(job);
    }
  }
}
