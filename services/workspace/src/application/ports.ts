import type { Actor } from "@visualsprint/platform";
import type { DomainEvent, CalendarMeeting } from "@visualsprint/contracts";
import type { MeetingAccess } from "../domain/permissions.js";

export interface MembershipAuthority {
  operationConnection?(actor: Actor): Promise<string>;
  requireActive(actor: Actor): Promise<void>;
  requireMember(workspaceId: string, userId: string, delegatedBy: Actor): Promise<void>;
}
export interface PolicyAuthority {
  checkMany(
    actor: Actor,
    checks: { meetingId: string; access: MeetingAccess; relation: "can_view" | "can_manage" }[],
  ): Promise<boolean[]>;
  check(
    actor: Actor,
    meetingId: string,
    access: MeetingAccess,
    relation: "can_view" | "can_manage",
  ): Promise<boolean>;
}
export interface EventPublisher {
  publish(event: DomainEvent): Promise<void>;
}
export type Customer = {
  id: string;
  workspaceId: string;
  ownerId: string;
  name: string;
  version: number;
};
export type Project = Customer & { customerId: string | null };
export type Meeting = {
  id: string;
  workspaceId: string;
  ownerId: string;
  title: string;
  notes: string;
  joinUrl: string | null;
  version: number;
  blocked: boolean;
  createdAt: Date;
};
export interface WorkspaceTransaction {
  calendarConnection(meetingId: string): Promise<string | null>;
  upsertCalendar(input: CalendarMeeting): Promise<{ meeting: Meeting; changed: boolean }>;
  calendarCaptureAllowed(meetingId: string): Promise<boolean>;
  customer(id: string): Promise<Customer | undefined>;
  project(id: string): Promise<Project | undefined>;
  meeting(id: string): Promise<Meeting | undefined>;
  meetingAccess(id: string): Promise<MeetingAccess | undefined>;
  listCustomers(): Promise<Customer[]>;
  listProjects(): Promise<Project[]>;
  listMeetings(projectId?: string): Promise<Meeting[]>;
  createCustomer(record: Customer): Promise<Customer>;
  createProject(record: Project): Promise<Project>;
  createMeeting(record: Omit<Meeting, "createdAt">): Promise<Meeting>;
  updateMeeting(
    id: string,
    expectedVersion: number,
    changes: { title?: string; notes?: string },
  ): Promise<Meeting>;
  assign(meetingId: string, projectId: string, actorId: string): Promise<void>;
  share(meetingId: string, userId: string): Promise<void>;
  unshare(meetingId: string, userId: string): Promise<void>;
  emit(event: DomainEvent): Promise<void>;
}
export interface WorkspaceRepository {
  read<T>(actor: Actor, work: (tx: WorkspaceTransaction) => Promise<T>): Promise<T>;
  command<T>(
    actor: Actor,
    key: string,
    fingerprint: string,
    work: (tx: WorkspaceTransaction) => Promise<T>,
    guard?: (tx: WorkspaceTransaction) => Promise<void>,
  ): Promise<T>;
}
