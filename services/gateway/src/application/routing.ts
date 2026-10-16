export type CellService =
  | "workspace"
  | "ingest"
  | "integration"
  | "intelligence"
  | "workflow"
  | "reporting"
  | "notification";
export function routeService(path: string): CellService | undefined {
  if (path === "realtime/negotiate") return "notification";
  if (/^(?:notifications|notification-preferences)(?:\/|$)/.test(path)) return "notification";
  if (
    /^(?:captures|transcripts|imports)(?:\/|$)/.test(path) ||
    /^meetings\/[^/]+\/captures(?:\/|$)/.test(path)
  )
    return "ingest";
  if (
    /^(?:connections|calendars|integrations|action-connections|action-executions)(?:\/|$)/.test(
      path,
    )
  )
    return "integration";
  if (/^(?:intelligence|chats|summaries|proposals|preparation)(?:\/|$)/.test(path))
    return "intelligence";
  if (/^(?:actions|approvals|operations)(?:\/|$)/.test(path)) return "workflow";
  if (/^exports(?:\/|$)/.test(path)) return "reporting";
  if (/^(?:customers|projects|meetings|decisions|commitments|agendas|deletions)(?:\/|$)/.test(path))
    return "workspace";
  return undefined;
}
