import { createHash } from "node:crypto";
import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";
export const agendaContent = z.object({
  title: z.string().trim().min(1).max(250),
  body: z.string().trim().min(1).max(32000),
});
export const createAgenda = agendaContent
  .extend({
    expectedMeetingVersion: z.number().int().positive(),
    confirmed: z.literal(true),
  })
  .strict();
export const updateAgenda = createAgenda
  .extend({ expectedVersion: z.number().int().positive() })
  .strict();
export const deleteAgenda = z
  .object({
    expectedMeetingVersion: z.number().int().positive(),
    expectedVersion: z.number().int().positive(),
    confirmed: z.literal(true),
  })
  .strict();
export type AgendaDTO = {
  id: string;
  meetingId: string;
  title: string;
  body: string;
  version: number;
  reviewed: true;
  createdAt: string;
  updatedAt: string;
};
export type DeletedAgenda = { id: string; meetingId: string; deleted: true; version: number };
export type AgendaCommand = {
  operation: "create" | "update" | "delete";
  meetingId: string;
  agendaId?: string;
  input: z.infer<typeof createAgenda> | z.infer<typeof updateAgenda> | z.infer<typeof deleteAgenda>;
};
export type AgendaSnapshot = {
  meetingVersion: number;
  agendas: AgendaDTO[];
  accepted: { id: string; kind: "decision" | "commitment"; version: number }[];
};
export interface AgendaStore {
  command(actor: Actor, key: string, command: AgendaCommand): Promise<AgendaDTO | DeletedAgenda>;
  snapshot(actor: Actor, meetingId: string, includeAccepted?: boolean): Promise<AgendaSnapshot>;
}
export interface AgendaAuthority {
  meeting(
    actor: Actor,
    meetingId: string,
  ): Promise<{ id: string; ownerId: string; version: number }>;
}
export interface AgendaManagementAuthority extends AgendaAuthority {
  manageContext(actor: Actor, meetingId: string): Promise<{ meetingId: string; ownerId: string }>;
}
export const agendaFingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function normalAgendaActor(actor: Actor) {
  if (actor.operationGrantId || actor.sessionId.startsWith("operation:"))
    throw new AppError("FORBIDDEN", 403);
}
export class AgendasService {
  constructor(
    private readonly store: AgendaStore,
    private readonly authority: AgendaManagementAuthority,
  ) {}
  private async owner(actor: Actor, meetingId: string) {
    normalAgendaActor(actor);
    const meeting = await this.authority.meeting(actor, id.parse(meetingId));
    if (meeting.ownerId !== actor.actorId) throw new AppError("FORBIDDEN", 403);
    const managed = await this.authority.manageContext(actor, meetingId);
    if (managed.meetingId !== meetingId || managed.ownerId !== actor.actorId)
      throw new AppError("FORBIDDEN", 403);
    return meeting;
  }
  async mutate(
    actor: Actor,
    meetingId: string,
    key: string,
    operation: AgendaCommand["operation"],
    body: unknown,
    agendaId?: string,
  ) {
    await this.owner(actor, meetingId);
    z.string()
      .min(8)
      .max(200)
      .regex(/^[A-Za-z0-9_.:-]+$/)
      .parse(key);
    const input =
      operation === "create"
        ? createAgenda.parse(body)
        : operation === "update"
          ? updateAgenda.parse(body)
          : deleteAgenda.parse(body);
    if (operation !== "create" && !agendaId) throw new AppError("AGENDA_ID_REQUIRED", 400);
    const result = await this.store.command(actor, key, {
      operation,
      meetingId,
      ...(agendaId ? { agendaId: id.parse(agendaId) } : {}),
      input,
    });
    await this.owner(actor, meetingId);
    return result;
  }
  async list(actor: Actor, meetingId: string) {
    normalAgendaActor(actor);
    const before = await this.authority.meeting(actor, id.parse(meetingId));
    const snapshot = await this.store.snapshot(actor, meetingId, false);
    const after = await this.authority.meeting(actor, meetingId);
    if (before.version !== snapshot.meetingVersion || after.version !== snapshot.meetingVersion)
      throw new AppError("AGENDA_CONTEXT_CHANGED", 409);
    return snapshot.agendas;
  }
}
