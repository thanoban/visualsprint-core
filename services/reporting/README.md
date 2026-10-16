# Reporting service

Own database, forced tenant RLS and migration/runtime roles. Local API port 4107; PostgreSQL 55439. API/worker/migration compile to independent native Node entrypoints. Caller keys are pinned;
gateway can create/read/download, Workspace alone can send cleanup commands.

`POST /api/v3/workspaces/{workspaceId}/exports` accepts `{meetingId,format:"text"|"json"}` and
an idempotency key. It returns a durable job ID. Status and download stay private to that requesting
owner and reauthorize meeting access. Downloads are authenticated attachments with no-store and
nosniff; there are no public URLs or unguarded blob links.

The worker retrieves finalized capture transcripts and a complete reviewed Workspace snapshot
through owning authorized APIs, preserving segment IDs/revisions, uncertain speakers, coverage,
accepted decisions/commitments and owner-reviewed agendas. JSON artifacts now use `schemaVersion: 2`.
Accepted human completion is not verified external task completion: exports label external status
unknown/not included. Generated summaries/preparation drafts and live provider task status are not
included and are never substituted for approved agendas or accepted facts.

Both prepublication and download validate complete current source fingerprints. The source adapter
rechecks meeting metadata, reviewed records and the capture manifest after text retrieval, including
accepted revisions that do not change the meeting version. Reviewed content, evidence status,
citations, human state and agenda versions/content all participate in the fingerprint. Current
citations must match exact retrieved capture/segment revisions; changed/unavailable evidence remains
labeled historical human review, not newly verified speech. Permission or deletion failures prevent
publication/download. Expiry is rechecked after validation; an expired worker lease cannot publish.

Required private source contracts, both pinned to the Reporting signer and normal delegated actor:

- Workspace GET `/internal/workspaces/{workspaceId}/meetings/{meetingId}/export-context`:
  strict `schemaVersion: 1` / `complete: true` and exact target/version; decisions, commitments and agendas.
- Ingest GET `/internal/workspaces/{workspaceId}/meetings/{meetingId}/export-captures`:
  strict `complete: true`, exact meeting and unique capture ID/version/state/coverage metadata.

There is no fallback to capped public lists, missing endpoints, fabricated empty arrays, operation
grants or another workspace's data. The API and worker require the owning Workspace/Ingest releases
and configured `REPORTING_PUBLIC_JWKS` pins together. Existing source origin/signer settings suffice;
there is no new secret or database migration.

Retrieval is bounded at 100 records of each reviewed kind, 100 agendas, 100 captures, 20,000 transcript
segments, 2 MB Workspace context, 1.5 MB aggregate compact source content and 2 MB rendered output. These
are failure bounds, not truncation limits: oversize errors fail rather than produce an incomplete
"complete" artifact. Source snapshots may disclose partial capture coverage independently.
Text artifacts expire in 24 hours and the worker purges stored content. No raw audio/video is stored.
Old schema-1 artifacts may fail current-source validation after this upgrade; request a fresh export
rather than relabeling an existing stored artifact. Existing data is not rewritten by a migration.

`POST /internal/workspaces/{workspaceId}/deletions/{deletionId}` accepts `{meetingId,sourceVersion}`.
The Workspace-only cleanup capability survives user logout but grants no content reads. Deletion
atomically tombstones the meeting, purges artifacts and fences generation; retries cannot resurrect
content or change the target. Workspace owns saga completion and must collect every required service
acknowledgement. Missing participants do not count as deleted.

Fast tests cover strict contracts, signed real HTTP reads against controlled owning-service fixtures,
rendering, complete-manifest failures and revision/permission races. Owning PostgreSQL tests cover
job idempotency, accepted/agenda invalidation, authorization/deletion fences, worker lease expiry and
download expiry. Tests use dedicated local fixture workspaces and do not contact live providers.
The upgrade passed 12 fast/signed-HTTP tests, all seven owning PostgreSQL/HTTP cases and the native
API/worker build locally on 2026-10-16 after Docker recovery, using preserved volumes and isolated
fixture workspaces. No schema migration or database reset was added by Reporting. Source collaborators
are controlled in the owning database suite; these results do not prove the complete service fleet.
Live WorkOS, signed real multi-service composition, Azure private
deployment/Blob delivery and complete multi-service deletion remain separate release gates.
Restored databases must replay Workspace deletion tombstones before admitting reads. Backups have
separate retention; this service does not erase backups.
