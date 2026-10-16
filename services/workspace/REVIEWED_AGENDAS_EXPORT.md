# Owner-reviewed agendas and complete export context

Status: implemented source/native Workspace mounting and qualified locally on 2026-10-16. Migration 0006 applied unchanged; six new owning PostgreSQL/signed-HTTP cases, the complete 27-case Workspace database suite and five isolated commitment-qualification cases all passed with zero skips. Fast tests passed 14/14; typecheck and native build passed. Composed Reporting/browser and production qualification are separate checks, not implied by owning database results. This slice makes no model, provider, Azure or external write calls.

## Explicit human review

Agendas belong to Workspace and one meeting. Native endpoints use the normal gateway-pinned actor, current Account membership, local meeting ACL and OpenFGA checks. A project/customer assignment or workspace administrator status does not confer meeting access. Operation grants and operation-prefixed sessions cannot use these endpoints.

| Endpoint under `/api/v3/workspaces/:workspaceId`     | Contract                                                                                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| GET `/meetings/:meetingId/agendas`                   | Complete reviewed AgendaDTO list, at most 100; shared meeting readers may read                                                |
| POST `/meetings/:meetingId/agendas`                  | Owner only; idempotency-key; `{title,body,confirmed:true,expectedMeetingVersion}`                                             |
| PATCH `/meetings/:meetingId/agendas/:agendaId`       | Owner only; idempotency-key; same content/confirmation plus `expectedVersion`                                                 |
| POST `/meetings/:meetingId/agendas/:agendaId/delete` | Owner only; idempotency-key; `{confirmed:true,expectedMeetingVersion,expectedVersion}`; metadata-only deleted acknowledgement |

Title/body trim to nonempty and are bounded at 250 / 32,000 characters. AgendaDTO is exactly `{id,meetingId,title,body,version,reviewed:true,createdAt,updatedAt}` with ISO timestamps. All public agenda responses are no-store.

Every actual create/edit/delete increments the owning meeting's version atomically and emits a metadata-only `meeting.updated.v1` outbox event. **Clients must reload the meeting version before another edit.** Agenda edits/deletions additionally check the agenda version. Identical idempotent commands do not duplicate edits; changed payload reuse conflicts. Read/mutation publication rechecks current authority. A normal command replay returns the current visible agenda; an already deleted agenda cannot be resurrected by replaying its original create/edit command.

Generated Intelligence preparation remains a draft, not an agenda. There is no automatic acceptance, model-created reviewed record or permission grant in this service. An owner may explicitly copy/review text and confirm it as an agenda. Frontend agenda controls and preparation-to-review presentation are separate UI work; this source slice is not a UI-completion claim.

## Reporting-only complete context

`GET /internal/workspaces/:workspaceId/meetings/:meetingId/export-context` requires a separately pinned **Reporting** service signature and normal, currently authorized delegated user. Gateway, Intelligence, Workflow, unsigned requests, wrong workspace, synthetic operation session or operation grant are rejected. The native mount does not reuse the broad read-service authenticator.

The exact DTO is:

```text
{ schemaVersion:1, complete:true, meetingId, meetingVersion,
  decisions:ReviewedExportRecord[], commitments:ReviewedExportRecord[], agendas:AgendaDTO[] }
```

ReviewedExportRecord contains exactly `id, meetingId, kind, title, text, ownerId, dueDate, state, version, sourceMeetingVersion, citations, sourcePartial, humanReviewed:true, humanCorrected, evidenceStatus, statusSource:'human_review', createdAt, updatedAt`. Each citation preserves `captureId,segmentId,revision,captureVersion,coverage`. Evidence status remains `current`, `changed` or `unavailable`; an accepted human review does not falsely certify unchanged transcript evidence. External task completion is not inferred from these fields.

The endpoint calls accepted record listing with **requireComplete=true**. More than 100 decisions, 100 commitments or 100 agendas fails explicitly rather than returning the first page with `complete:true`. A serialized context above 2,000,000 UTF-8 bytes fails `EXPORT_CONTEXT_TOO_LARGE`/409; Reporting must preserve this failure, never substitute empty arrays or claim full export. Complete capture/transcript/Intelligence context remains separately owned by Ingest/Intelligence and Reporting's composition.

Before reading records, Workspace takes a repeatable-read local snapshot of the meeting revision, all agenda content/versions and the complete accepted `id/kind/version` index. After evidence-linked accepted views are built, their returned index must match that snapshot. A second local snapshot and a final current Account/local-ACL/FGA authority check must match before publication. **Accepted corrections do not currently increment the meeting revision**, so comparing meetingVersion alone would be insufficient; the accepted index prevents this race. Normal concurrent edits, deletion, access revocation or missing rows fail closed.

## Persistence and deletion

Append-only owning migration `0006_reviewed_agendas.sql` adds tenant-keyed `reviewed_agendas` and payload-free `agenda_commands`. Both have forced PostgreSQL RLS and service-only grants; runtime remains a non-owner/non-BYPASSRLS role. Agenda command serialization and the locked meeting row make duplicate requests and concurrent deletion deterministic. No business table/model is imported by another service.

Applied migration SHA-256 (immutable): `0006_reviewed_agendas.sql` = `66d5bac3f5415e086583484b00526a59539c4911cd2032d7b59ecbcd99b1278c`. Corrections now require a new append-only migration. The local qualification bootstrap verified its explicitly named isolated database/roles and preserved the restored volumes and main Workspace data.

The existing Workspace deletion transaction blocks the meeting and immediately purges agenda text **and command references**, alongside accepted records/notes/assignments. Old commands cannot replay content after deletion, and the existing durable participant acknowledgement saga remains unchanged. PostgreSQL backups still follow their disclosed retention; source deletion is not an immediate backup-erasure claim.

Verification entrypoints:

```text
pnpm --filter @visualsprint/workspace test
pnpm --filter @visualsprint/workspace typecheck
pnpm --filter @visualsprint/workspace exec tsx --test test/integration/agendas.test.ts
pnpm --filter @visualsprint/workspace test:integration
pnpm --filter @visualsprint/workspace exec tsx --test test/qualification/commitments.test.ts
pnpm --filter @visualsprint/workspace build
```

The PostgreSQL tests fail when the configured owning database is unavailable; they do not skip or claim persistence qualification through mocks. Controlled Account/OpenFGA/evidence collaborators in those tests do not prove live identity, model, capture or Azure behavior. Signed Workspace → Reporting composition and browser flows are additional release checks.
