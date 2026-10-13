import {useEffect,useState} from "react";
import {z} from "zod";
import {id} from "@visualsprint/contracts";
import {Api,errorMessage} from "./api.js";
const job=z.object({id,meetingId:id,state:z.enum(["pending","complete"]),required:z.array(z.string()),completed:z.array(z.string())});
export function DeletionStatus({api,workspaceId,deletionId}:{api:Api;workspaceId:string;deletionId:string}) {
  const [value,setValue]=useState<z.infer<typeof job>>(),[error,setError]=useState<unknown>(),[retry,setRetry]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    setValue(undefined);setError(undefined);
    async function poll(){try{const next=await api.request(`${api.scope(workspaceId)}/deletions/${id.parse(deletionId)}`,job,{signal:controller.signal});if(controller.signal.aborted)return;setValue(next);setError(undefined);if(next.state==="pending")timer=setTimeout(()=>void poll(),3000);}catch(reason){if(!controller.signal.aborted)setError(reason);}}
    void poll();return()=>{controller.abort();if(timer)clearTimeout(timer);};
  },[api,workspaceId,deletionId,retry]);
  return <section className="panel" aria-label="Deletion status"><h2>Deletion status</h2>
    <p>Meeting access is blocked. This view contains cleanup references only.</p>
    {error?<p role="alert">{errorMessage(error)}</p>:null}
    {value?<><p role="status">{value.state==="complete"?"Required local cleanup is complete.":"Cleanup is still pending."} {value.completed.length}/{value.required.length} services acknowledged.</p>
      {value.state==="pending"?<p>Waiting for: {value.required.filter(name=>!value.completed.includes(name)).join(", ")}. Provider departure and uncertain operations are not treated as completed.</p>:<p>Backups follow their separate retention policy. External task cleanup has separate status; local completion does not claim external tasks were deleted.</p>}</>:<p>Loading cleanup status…</p>}
    <button className="secondary" onClick={()=>setRetry(n=>n+1)}>Refresh deletion status</button>
  </section>;
}
