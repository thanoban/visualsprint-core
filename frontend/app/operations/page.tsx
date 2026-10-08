"use client";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/AuthProvider";
import { useWorkspaceData } from "@/features/founder/useWorkspaceData";
import { DataOperations, OperationReceipt } from "@/features/founder/DataOperations";

function Operations() {
  const { me } = useAuth(); const query = useSearchParams();
  const workspace = useWorkspaceData<{ id: string; name: string; role: string }>("");
  const receiptWorkspace = query.get("workspace"); const deletion = query.get("deletions"); const exported = query.get("exports");
  return <main className="founder-shell"><h1>Data operations</h1>
    {receiptWorkspace && (deletion || exported) && <OperationReceipt key={`${me?.user.id}:${receiptWorkspace}:${deletion || exported}`} workspace={receiptWorkspace} kind={deletion ? "deletions" : "exports"} id={deletion || exported || ""} />}
    {me && workspace.data && <DataOperations key={`${me.user.id}:${me.org.id}`} kind="workspace" id={me.org.id} name={me.org.name} canDelete={workspace.data.role === "owner"} />}
    {workspace.error && <p role="alert">{workspace.error}</p>}
  </main>;
}
export default function OperationsPage() { return <Suspense fallback={<p>Loading data operations…</p>}><Operations /></Suspense>; }
