"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import type { Customer, Project } from "@/lib/founder-api";
import { useWorkspaceData } from "@/features/founder/useWorkspaceData";
import { MeetingHistory } from "@/features/founder/MeetingHistory";
import { ScopeMemory } from "@/features/founder/ScopeMemory";
import { SavedChats } from "@/features/founder/SavedChats";
import { useAuth } from "@/lib/AuthProvider";

export default function CustomerPage() {
  const { id } = useParams<{ id: string }>();
  const { me } = useAuth();
  const [revision, setRevision] = useState(0);
  const customers = useWorkspaceData<Customer[]>("/customers");
  const projects = useWorkspaceData<Project[]>("/projects");
  const customer = customers.data?.find((entry) => entry.id === id);
  return <main className="founder-shell"><Link href="/customers">All customers</Link>
    {customers.error && <p className="founder-error" role="alert">{customers.error}</p>}
    {!customers.data && !customers.error && <p role="status">Loading customer…</p>}
    {customers.data && !customer && <h1>Customer unavailable</h1>}
    {customer && <><h1>{customer.name}</h1><p>Only projects and meetings you can access are included.</p>
      <h2>Projects</h2>{projects.error && <p className="founder-error" role="alert">{projects.error}</p>}
      <ul>{projects.data?.filter((project) => project.customer_id === id).map((project) => <li key={project.id}><Link href={`/projects/${project.id}`}>{project.name}</Link> · {project.status}</li>)}</ul>
      <h2>Customer meetings</h2><MeetingHistory key={id} scope={`&customer_id=${encodeURIComponent(id)}`} onChanged={() => setRevision((value) => value + 1)} />
      <ScopeMemory key={`${id}:${revision}`} kind="customers" id={id} />
      <SavedChats key={`${me?.user.id}:${me?.org.id}:${id}`} kind="customer" id={id} /></>}
  </main>;
}
