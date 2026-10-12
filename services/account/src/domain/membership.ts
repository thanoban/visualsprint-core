export type Role = "owner" | "member";
export function mayChangeMembership(role: Role, targetIsSelf: boolean, revoke: boolean): boolean {
  return role === "owner" && !(targetIsSelf && revoke);
}
