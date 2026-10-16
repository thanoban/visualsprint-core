# Complete capture manifests for text exports

Reporting uses the private GET
`/internal/workspaces/:workspaceId/meetings/:meetingId/export-captures`.
The native API verifies its pinned Reporting signing key (`REPORTING_PUBLIC_JWKS`),
normal delegated user actor and exact workspace. Neither calendar nor processing
operation grants authorize this endpoint. Current meeting-read permission is checked
before the owning query and again before publishing any manifest or overflow error.

The exact response is `{meetingId, complete: true, captures: [{id, version, state, coverage}]}`.
No meeting URLs, passcodes, provider identifiers, owner/session values or transcript text
are included. An authorized empty result is explicitly complete. The owning deletion
barrier denies stale remote permission projections independently of Workspace checks.

The owning query reads at most 101 records. Exactly 100 can be exported; more causes
`CAPTURE_EXPORT_SCOPE_TOO_LARGE` (409), never a truncated successful response. Reporting
must not fall back to the existing capped public capture array. That public endpoint is
unchanged for compatibility. Reporting remains responsible for transcript pagination,
revision-frame validation and current permission checks on the generated artifact.

Local tests cover empty/exact-limit/overflow manifests, before-and-after revocation,
normal-owner/tenant/caller/operation boundaries, deletion and actual PostgreSQL RLS.
These are local qualification checks, not production or paid-provider validation.
