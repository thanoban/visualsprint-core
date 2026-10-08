"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import type { Project } from "@/lib/founder-api";
import { useWorkspaceData } from "@/features/founder/useWorkspaceData";
import { MeetingHistory } from "@/features/founder/MeetingHistory";
import { ScopeMemory } from "@/features/founder/ScopeMemory";
import { ProjectSettings } from "@/features/founder/ProjectSettings";
import { CapturePanel } from "@/features/founder/CapturePanel";
import { SavedChats } from "@/features/founder/SavedChats";
import { DataOperations } from "@/features/founder/DataOperations";
import { useAuth } from "@/lib/AuthProvider";

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const { me } = useAuth();
  const identity = `${me?.user.id}:${me?.org.id}:${id}`;
  const project = useWorkspaceData<Project>(`/projects/${encodeURIComponent(id)}`);
  if (project.error) return <main className="founder-shell"><h1>Project unavailable</h1><p role="alert" className="founder-error">{project.error}</p><Link href="/projects">Back to projects</Link></main>;
  if (!project.data) return <main className="founder-shell"><p role="status">Loading project…</p></main>;
  return <main className="founder-shell"><Link href="/projects">All projects</Link><h1>{project.data.name}</h1>
    <p>{project.data.visibility} project · {project.data.role} · {project.data.status}</p>
    {project.data.customer_id && <Link href={`/customers/${project.data.customer_id}`}>Customer history</Link>}
    {project.data.status === "active" && project.data.role !== "viewer" && <CapturePanel key={identity} projectId={id} />}
    <h2>Project meetings</h2><MeetingHistory key={id} scope={`&project_id=${encodeURIComponent(id)}`} onChanged={project.refresh} />
    <ScopeMemory key={`${id}:${project.data.version}`} kind="projects" id={id} />
    <SavedChats key={identity} kind="project" id={id} />
    <ProjectSettings key={`${id}:${project.data.version}`} project={project.data} onChanged={project.refresh} />
    <DataOperations key={identity} kind="project" id={id} name={project.data.name} canDelete={project.data.role === "owner"} />
  </main>;
}
