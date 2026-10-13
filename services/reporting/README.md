# Reporting service

Own database, forced tenant RLS and migration/runtime roles. Local API port 4107; PostgreSQL 55439. API/worker/migration compile to independent native Node entrypoints. Caller keys are pinned;
gateway can create/read/download, Workspace alone can send cleanup commands.

`POST /api/v3/workspaces/{workspaceId}/exports` accepts `{meetingId,format:"text"|"json"}` and
an idempotency key. It returns a durable job ID. Status and download stay private to that requesting
owner and reauthorize meeting access. Downloads are authenticated attachments with no-store and
nosniff; there are no public URLs or unguarded blob links.

The worker retrieves finalized capture transcripts through owning authorized APIs, preserving
segment IDs/revisions, uncertain speakers and coverage states. Both prepublication and download
validate current source fingerprints. It bounds retrieval/output; oversized sources fail rather
than silently truncate. Current outputs include meeting notes and transcript text, not generated
summaries until that owning-service read contract is integrated. Text artifacts expire in 24 hours
and the owning worker purges stored content. Model and raw audio/video content are not stored here.

`POST /internal/workspaces/{workspaceId}/deletions/{deletionId}` accepts `{meetingId,sourceVersion}`.
The Workspace-only cleanup capability survives user logout but grants no content reads. Deletion
atomically tombstones the meeting, purges artifacts and fences generation; retries cannot resurrect
content or change the target. Workspace owns saga completion and must collect every required service
acknowledgement. Missing participants do not count as deleted.

Local tests exercise real PostgreSQL with controlled evidence authority; live WorkOS, gateway
composition, Azure private deployment/Blob export delivery and complete multi-service deletion
qualification remain separate gates. Restored databases must replay Workspace deletion tombstones
before admitting reads. Backups have separate retention; this service does not erase backups.
