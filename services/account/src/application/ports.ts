import type { Actor, Identity } from "@visualsprint/platform";
import type { DomainEvent } from "@visualsprint/contracts";
import type { Role } from "../domain/membership.js";
import type { UsageTotals } from "../domain/usage.js";
export type CaptureReservation = {
  workspaceId: string;
  requestId: string;
  ownerId: string;
  maxSeconds: number;
  period: string;
  state: "held" | "settled" | "released";
  chargedSeconds: number | null;
  version: number;
};
export type AccountWorkspace = {
  id: string;
  creatorId: string;
  name: string;
  cellId: string;
  blocked: boolean;
};
export type Membership = {
  workspaceId: string;
  userId: string;
  role: Role;
  active: boolean;
  version: number;
};
export interface AccountTransaction {
  actorId: string;
  setWorkspace(workspaceId: string): Promise<void>;
  workspaces(): Promise<AccountWorkspace[]>;
  workspace(workspaceId: string): Promise<AccountWorkspace | undefined>;
  membership(userId: string): Promise<Membership | undefined>;
  members(): Promise<Membership[]>;
  sessionRevoked(sessionId: string): Promise<boolean>;
  revokeSession(sessionId: string): Promise<void>;
  addWorkspace(workspace: AccountWorkspace): Promise<AccountWorkspace>;
  addOwner(workspaceId: string): Promise<void>;
  changeMembership(userId: string, active: boolean, expectedVersion: number): Promise<Membership>;
  command<T>(key: string, fingerprint: string, work: () => Promise<T>): Promise<T>;
  emit(event: DomainEvent): Promise<void>;
  lockUsage(): Promise<void>;
  usage(): Promise<UsageTotals>;
  reservation(requestId: string): Promise<CaptureReservation | undefined>;
  reserve(requestId: string, maxSeconds: number): Promise<CaptureReservation>;
  finishReservation(
    requestId: string,
    state: "settled" | "released",
    seconds: number,
  ): Promise<CaptureReservation>;
}
export interface AccountRepository {
  identity<T>(identity: Identity, work: (tx: AccountTransaction) => Promise<T>): Promise<T>;
  actor<T>(actor: Actor, work: (tx: AccountTransaction) => Promise<T>): Promise<T>;
}
