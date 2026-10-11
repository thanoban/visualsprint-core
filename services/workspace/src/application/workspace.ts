import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { id, eventEnvelope, type DomainEvent } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";
import { canManageMeeting, canReadMeeting } from "../domain/permissions.js";
import type { MembershipAuthority, WorkspaceRepository, WorkspaceTransaction } from "./ports.js";

const label = z.string().trim().min(1).max(200);
export const createCustomer = z.object({ name: label }).strict();
export const createProject = z.object({ name: label, customerId: id.nullable().default(null) }).strict();
export const createMeeting = z.object({ title: label, joinUrl: z.string().url().max(4096).nullable().default(null) }).strict();
export const editMeeting = z.object({ expectedVersion: z.number().int().positive(), title: label.optional(), notes: z.string().max(32_000).optional() }).strict()
  .refine(input => input.title !== undefined || input.notes !== undefined, "No changes supplied");
export const assignMeeting = z.object({ projectId: id, confirmed: z.literal(true), expectedVersion: z.number().int().positive() }).strict();
export const shareMeeting = z.object({ userId: id, expectedVersion: z.number().int().positive() }).strict();
const idempotencyKey = z.string().min(8).max(200).regex(/^[A-Za-z0-9_.:-]+$/);

export class WorkspaceService {
  constructor(private readonly repository: WorkspaceRepository, private readonly memberships: MembershipAuthority) {}

  private async authorize(actor: Actor) { await this.memberships.requireActive(actor); }
  private command<T>(actor: Actor, key: string, operation: string, input: unknown, work: (tx: WorkspaceTransaction) => Promise<T>, guard?: (tx: WorkspaceTransaction) => Promise<void>) {
    const fingerprint = createHash("sha256").update(JSON.stringify([operation, input])).digest("hex");
    return this.repository.command(actor, idempotencyKey.parse(key), fingerprint, work, guard);
  }
  private async owner(tx: WorkspaceTransaction, actor: Actor, meetingId: string) {
    const access = await tx.meetingAccess(id.parse(meetingId));
    if (!access || !canManageMeeting(actor.actorId, access)) throw new AppError("NOT_FOUND", 404);
  }
  private event(actor: Actor, type: DomainEvent["type"], aggregateId: string, aggregateVersion: number,
    references: DomainEvent["references"]): DomainEvent {
    return eventEnvelope.parse({ eventId: randomUUID(), type, schemaVersion: 1,
      workspaceId: actor.workspaceId, aggregateId, aggregateVersion,
      occurredAt: new Date().toISOString(), traceId: randomBytes(16).toString("hex"), actorId: actor.actorId, references });
  }
  async customers(actor: Actor) { await this.authorize(actor); return this.repository.read(actor, tx => tx.listCustomers()); }
  async projects(actor: Actor) { await this.authorize(actor); return this.repository.read(actor, tx => tx.listProjects()); }
  async meetings(actor: Actor, projectId?: string) {
    await this.authorize(actor);
    return this.repository.read(actor, async tx => {
      if (projectId) {
        const project = await tx.project(id.parse(projectId));
        if (!project) throw new AppError("NOT_FOUND", 404);
      }
      return tx.listMeetings(projectId);
    });
  }
  async meeting(actor: Actor, meetingId: string) {
    await this.authorize(actor);
    return this.repository.read(actor, async tx => {
      const access = await tx.meetingAccess(id.parse(meetingId));
      if (!access || !canReadMeeting(actor.actorId, access)) throw new AppError("NOT_FOUND", 404);
      const meeting = await tx.meeting(meetingId);
      if (!meeting) throw new AppError("NOT_FOUND", 404);
      return meeting;
    });
  }
  async addCustomer(actor: Actor, key: string, body: unknown) {
    await this.authorize(actor); const input = createCustomer.parse(body);
    return this.command(actor, key, "customer.create", input, async tx => {
      const record = await tx.createCustomer({ id: randomUUID(), workspaceId: actor.workspaceId, ownerId: actor.actorId, name: input.name, version: 1 });
      await tx.emit(this.event(actor, "customer.created.v1", record.id, 1, [{kind: "customer", id: record.id}]));
      return record;
    });
  }
  async addProject(actor: Actor, key: string, body: unknown) {
    await this.authorize(actor); const input = createProject.parse(body);
    return this.command(actor, key, "project.create", input, async tx => {
      if (input.customerId && !(await tx.customer(input.customerId))) throw new AppError("NOT_FOUND", 404);
      const record = await tx.createProject({ id: randomUUID(), workspaceId: actor.workspaceId, ownerId: actor.actorId, ...input, version: 1 });
      await tx.emit(this.event(actor, "project.created.v1", record.id, 1, [{kind: "project", id: record.id}]));
      return record;
    });
  }
  async addMeeting(actor: Actor, key: string, body: unknown) {
    await this.authorize(actor); const input = createMeeting.parse(body);
    // A meeting may be an import with no link. Capture performs platform-specific validation.
    if (input.joinUrl) {
      const url = new URL(input.joinUrl);
      if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new AppError("INVALID_LINK", 400);
    }
    const record = await this.command(actor, key, "meeting.create", input, async tx => {
      const record = await tx.createMeeting({ id: randomUUID(), workspaceId: actor.workspaceId, ownerId: actor.actorId, ...input, notes: "", version: 1, blocked: false });
      await tx.emit(this.event(actor, "meeting.created.v1", record.id, 1, [{kind: "meeting", id: record.id}]));
      return record;
    });
    // A replay must still respect a later deletion or permission barrier.
    return this.meeting(actor, record.id);
  }
  async edit(actor: Actor, meetingId: string, key: string, body: unknown) {
    await this.authorize(actor); const input = editMeeting.parse(body); id.parse(meetingId);
    return this.command(actor, key, `meeting.edit:${meetingId}`, input, async tx => {
      const changes: {title?: string; notes?: string} = {};
      if (input.title !== undefined) changes.title = input.title;
      if (input.notes !== undefined) changes.notes = input.notes;
      const record = await tx.updateMeeting(meetingId, input.expectedVersion, changes);
      await tx.emit(this.event(actor, "meeting.updated.v1", record.id, record.version, [{kind: "meeting", id: record.id, revision: record.version}]));
      return record;
    }, tx => this.owner(tx, actor, meetingId));
  }
  async assign(actor: Actor, meetingId: string, key: string, body: unknown) {
    await this.authorize(actor); const input = assignMeeting.parse(body); id.parse(meetingId);
    return this.command(actor, key, `meeting.assign:${meetingId}`, input, async tx => {
      if (!(await tx.project(input.projectId))) throw new AppError("NOT_FOUND", 404);
      const record = await tx.updateMeeting(meetingId, input.expectedVersion, {});
      await tx.assign(meetingId, input.projectId, actor.actorId);
      await tx.emit(this.event(actor, "meeting.assignment.confirmed.v1", record.id, record.version,
        [{kind: "meeting", id: record.id, revision: record.version}, {kind: "project", id: input.projectId}]));
      return record;
    }, tx => this.owner(tx, actor, meetingId));
  }
  async share(actor: Actor, meetingId: string, key: string, body: unknown, revoke = false) {
    await this.authorize(actor); const input = shareMeeting.parse(body); id.parse(meetingId);
    if (!revoke) await this.memberships.requireMember(actor.workspaceId, input.userId, actor);
    return this.command(actor, key, `meeting.${revoke ? "unshare" : "share"}:${meetingId}`, input, async tx => {
      const record = await tx.updateMeeting(meetingId, input.expectedVersion, {});
      if (revoke) await tx.unshare(meetingId, input.userId); else await tx.share(meetingId, input.userId);
      await tx.emit(this.event(actor, "meeting.access.changed.v1", record.id, record.version, [{kind: "meeting", id: record.id, revision: record.version}]));
      return record;
    }, tx => this.owner(tx, actor, meetingId));
  }
}
