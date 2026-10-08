"use client";

import Link from "next/link";
import { useState } from "react";
import { useAuth } from "@/lib/AuthProvider";
import { founderApi, type Customer } from "@/lib/founder-api";
import { useWorkspaceData } from "@/features/founder/useWorkspaceData";

export default function CustomersPage() {
  const { me, authedFetch } = useAuth();
  const customers = useWorkspaceData<Customer[]>("/customers");
  const [name, setName] = useState(""); const [pending, setPending] = useState(false); const [error, setError] = useState<string | null>(null);
  async function create(event: React.FormEvent) {
    event.preventDefault(); if (!me) return;
    setPending(true); setError(null);
    try { await founderApi(authedFetch, me.org.id).createCustomer(name.trim()); setName(""); customers.refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : "Customer creation failed"); }
    finally { setPending(false); }
  }
  return <main className="founder-shell"><h1>Customers</h1><p>Keep each customer’s projects, meeting history and context together.</p>
    <form className="founder-card" onSubmit={create}><label>Customer name<input required maxLength={255} value={name} onChange={(event) => setName(event.target.value)} /></label><button disabled={pending || !me || !name.trim()}>{pending ? "Creating…" : "Create customer"}</button></form>
    {(error || customers.error) && <p className="founder-error" role="alert">{error ?? customers.error}</p>}
    {!customers.data && !customers.error && <p role="status">Loading customers…</p>}
    {customers.data?.length === 0 && <p>No customers yet.</p>}
    <div className="founder-grid">{customers.data?.map((customer) => <article className="founder-card" key={customer.id}><h2><Link href={`/customers/${customer.id}`}>{customer.name}</Link></h2><p>{customer.visible_project_count} accessible projects · {customer.status}</p></article>)}</div>
  </main>;
}
