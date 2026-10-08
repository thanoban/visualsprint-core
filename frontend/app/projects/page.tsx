"use client";

import Link from "next/link";
import { useState } from "react";
import { useAuth } from "@/lib/AuthProvider";
import { founderApi, type Customer, type Project } from "@/lib/founder-api";
import { useWorkspaceData } from "@/features/founder/useWorkspaceData";

export default function ProjectsPage() {
  const { me, authedFetch } = useAuth();
  const projects = useWorkspaceData<Project[]>("/projects");
  const customers = useWorkspaceData<Customer[]>("/customers");
  const [name, setName] = useState(""); const [customerId, setCustomerId] = useState("");
  const [pending, setPending] = useState(false); const [error, setError] = useState<string | null>(null);
  async function create(event: React.FormEvent) {
    event.preventDefault(); if (!me) return;
    setPending(true); setError(null);
    try { await founderApi(authedFetch, me.org.id).createProject(name.trim(), customerId || null); setName(""); projects.refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : "Project creation failed"); }
    finally { setPending(false); }
  }
  return <main className="founder-shell"><h1>Projects</h1><p>Separate each customer engagement or internal workstream. Meetings and memory stay inside the project you choose.</p>
    <form className="founder-card" onSubmit={create}><h2>Create a private project</h2>
      <label>Project name<input required maxLength={255} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>Customer<select value={customerId} onChange={(event) => setCustomerId(event.target.value)}><option value="">Internal / no customer</option>{customers.data?.filter((customer) => customer.status === "active").map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></label>
      <p>New projects are private. Only explicitly added project members can read assigned meetings.</p>
      <button disabled={pending || !me || !name.trim()}>{pending ? "Creating…" : "Create project"}</button>
    </form>
    {(error || projects.error || customers.error) && <p className="founder-error" role="alert">{error ?? projects.error ?? customers.error}</p>}
    {!projects.data && !projects.error && <p role="status">Loading projects…</p>}
    {projects.data?.length === 0 && <p>No projects yet. Create your first project above.</p>}
    <div className="founder-grid">{projects.data?.map((project) => <article className="founder-card" key={project.id}><h2><Link href={`/projects/${project.id}`}>{project.name}</Link></h2><p>{project.role} · {project.visibility} · {project.status}</p><p>{customers.data?.find((customer) => customer.id === project.customer_id)?.name ?? "Internal project"}</p></article>)}</div>
    <Link href="/unassigned">Open Unassigned meetings</Link>
  </main>;
}
