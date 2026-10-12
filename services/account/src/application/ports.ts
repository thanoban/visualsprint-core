import type {Actor, Identity} from "@visualsprint/platform";
import type {DomainEvent} from "@visualsprint/contracts";
import type {Role} from "../domain/membership.js";
export type AccountWorkspace = {id: string; creatorId: string; name: string; cellId: string; blocked: boolean};
export type Membership = {workspaceId: string; userId: string; role: Role; active: boolean; version: number};
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
}
export interface AccountRepository {
  identity<T>(identity: Identity, work: (tx: AccountTransaction) => Promise<T>): Promise<T>;
  actor<T>(actor: Actor, work: (tx: AccountTransaction) => Promise<T>): Promise<T>;
}
