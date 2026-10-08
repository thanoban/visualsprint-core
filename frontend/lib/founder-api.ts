/** Founder features use authenticated relative paths, never provider credentials/origins. */
export type AuthenticatedFetch = (path: string, init?: RequestInit) => Promise<Response>;
export interface Customer { id: string; name: string; status: string; version: number; visible_project_count: number }
export interface Project { id: string; name: string; customer_id: string | null; visibility: string; status: string; version: number; role: "owner" | "editor" | "viewer" }
export interface ProjectMember { user_id: string; role: string; email: string | null }
export interface Meeting {
  id: string; title: string; platform: string; created_at: string; scheduled_start: string | null;
  project_id: string | null; assignment_version: number; can_move: boolean;
  capture_session_id: string | null; processing_state: string | null;
  capture_request_id: string | null; capture_status: string | null; report_ready: boolean;
}
export interface MeetingPage { items: Meeting[]; next_cursor: string | null }
export interface Memory { id: string; source_meeting_ids: string[]; structured_summary: Record<string, unknown>; state: string }
export class ApiError extends Error {
  public status: number;
  constructor(status: number, message: string) { super(message); this.name = "ApiError"; this.status = status; }
}
export function workspacePath(workspaceId: string, suffix: string): string {
  if (!workspaceId || (suffix !== "" && !suffix.startsWith("/")) || suffix.startsWith("//")) throw new Error("Invalid workspace request");
  return `/api/v2/workspaces/${encodeURIComponent(workspaceId)}${suffix}`;
}
export async function apiJson<T>(fetcher: AuthenticatedFetch, path: string, init?: RequestInit): Promise<T> {
  const response = await fetcher(path, init);
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const error: { detail?: unknown } = await response.json();
      if (typeof error.detail === "string") message = error.detail.slice(0, 300);
    } catch { /* An empty/non-JSON error response still preserves the HTTP status. */ }
    throw new ApiError(response.status, message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
export function founderApi(fetcher: AuthenticatedFetch, workspaceId: string) {
  const request = <T>(suffix: string, init?: RequestInit) => apiJson<T>(fetcher, workspacePath(workspaceId, suffix), init);
  const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return {
    createCustomer: (name: string) => request<Customer>("/customers", json("POST", { name })),
    createProject: (name: string, customerId: string | null) => request<Project>("/projects", json("POST", { name, customer_id: customerId })),
    updateProject: (project: Project, changes: { name?: string; status?: "archived"; customer_id?: string | null }) => request<Project>(`/projects/${encodeURIComponent(project.id)}`, json("PATCH", { ...changes, version: project.version })),
    assignMeeting: (meeting: Meeting, projectId: string) => request(`/meetings/${encodeURIComponent(meeting.id)}/assignment`, json("PUT", { project_id: projectId, version: meeting.assignment_version })),
    unassignMeeting: (meeting: Meeting) => request<void>(`/meetings/${encodeURIComponent(meeting.id)}/assignment?version=${meeting.assignment_version}`, { method: "DELETE" }),
    addMember: (projectId: string, userId: string, role: string) => request<ProjectMember>(`/projects/${encodeURIComponent(projectId)}/members`, json("PUT", { user_id: userId, role })),
    removeMember: (projectId: string, userId: string) => request<void>(`/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" }),
  };
}
