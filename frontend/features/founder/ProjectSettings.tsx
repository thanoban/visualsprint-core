"use client";

import { useState } from "react";
import { useAuth } from "@/lib/AuthProvider";
import { founderApi, type Project, type ProjectMember } from "@/lib/founder-api";
import { useWorkspaceData } from "./useWorkspaceData";

export function ProjectSettings({ project, onChanged }: { project: Project; onChanged: () => void }) {
  const { me, authedFetch } = useAuth();
  const members = useWorkspaceData<ProjectMember[]>(`/projects/${project.id}/members`);
  const workspaceMembers = useWorkspaceData<ProjectMember[]>("/members");
  const [name, setName] = useState(project.name); const [selectedUser, setSelectedUser] = useState("");
  const [role, setRole] = useState("viewer"); const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function mutate(operation: () => Promise<unknown>) {
    setPending(true); setError(null);
    try { await operation(); members.refresh(); onChanged(); }
    catch (err) { setError(err instanceof Error ? err.message : "Update failed"); }
    finally { setPending(false); }
  }
  if (!me) return null;
  const api = founderApi(authedFetch, me.org.id);
  return <section className="founder-card"><h2>Project settings</h2><p>{project.visibility} · {project.role} · {project.status}</p>
    {project.role === "owner" && <>
      <form onSubmit={(event) => { event.preventDefault(); void mutate(() => api.updateProject(project, { name: name.trim() })); }}>
        <label>Project name<input value={name} maxLength={255} onChange={(event) => setName(event.target.value)} required /></label><button disabled={pending || !name.trim() || name.trim() === project.name}>Save name</button>
      </form>
      {project.status === "active" && <button disabled={pending} onClick={() => { if (window.confirm("Archive this project? Accessible history remains, but new assignments will be blocked.")) void mutate(() => api.updateProject(project, { status: "archived" })); }}>Archive project</button>}
      <form onSubmit={(event) => { event.preventDefault(); void mutate(() => api.addMember(project.id, selectedUser, role)); }}>
        <h3>Add or update a member</h3><p>Members can read all meetings assigned to this project. Viewers cannot move meetings; editors can contribute.</p>
        <label>Workspace member<select required value={selectedUser} onChange={(event) => setSelectedUser(event.target.value)}><option value="">Select a member</option>{workspaceMembers.data?.map((member) => <option key={member.user_id} value={member.user_id}>{member.email}</option>)}</select></label>
        <label>Project role<select value={role} onChange={(event) => setRole(event.target.value)}><option value="viewer">Viewer</option><option value="editor">Editor</option><option value="owner">Owner</option></select></label>
        <button disabled={pending || !selectedUser}>Save membership</button>
      </form>
    </>}
    {error && <p role="alert" className="founder-error">{error}</p>}
    {(members.error || workspaceMembers.error) && <p role="alert" className="founder-error">{members.error ?? workspaceMembers.error}</p>}
    <ul>{members.data?.map((member) => <li key={member.user_id}><span>{member.email ?? "Workspace member"} · {member.role}</span>{project.role === "owner" && <button disabled={pending} onClick={() => { if (window.confirm("Remove this member’s project access? Their dependent project threads will become inaccessible.")) void mutate(() => api.removeMember(project.id, member.user_id)); }}>Remove access</button>}</li>)}</ul>
  </section>;
}
