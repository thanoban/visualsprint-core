export type CellService="workspace"|"ingest"|"integration"|"intelligence"|"workflow"|"reporting";
export function routeService(path:string):CellService|undefined {
  if(/^(?:captures|transcripts|imports)(?:\/|$)/.test(path)||/^meetings\/[^/]+\/captures(?:\/|$)/.test(path))return "ingest";
  if(/^(?:connections|calendars|integrations)(?:\/|$)/.test(path))return "integration";
  if(/^(?:chats|summaries|proposals|preparation)(?:\/|$)/.test(path))return "intelligence";
  if(/^(?:actions|approvals)(?:\/|$)/.test(path))return "workflow";
  if(/^exports(?:\/|$)/.test(path))return "reporting";
  if(/^(?:customers|projects|meetings|decisions|commitments|agendas|deletions)(?:\/|$)/.test(path))return "workspace";
  return undefined;
}
