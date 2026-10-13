# Authz deletion participation — 2026-10-13

Authz owns the `authz_application` logical database and isolated runtime/migration roles on its
authorization PostgreSQL server. This is separate from OpenFGA-owned storage; Authz never directly
queries or mutates OpenFGA tables. Tenant RLS is forced. Runtime cannot delete tombstones, and a
database trigger forbids changing their target or reducing the deletion revision.

Production startup requires `AUTHZ_DATABASE_URL`, checks its runtime role and supplies the persisted
deletion barrier to every policy check. `AUTHZ_MIGRATION_DATABASE_URL` belongs only to migration
execution. Local fixture roles are created by `local-application-init.sql`; do not reset an existing
OpenFGA volume to run this script. Provision production roles through the controlled infrastructure
deployment. Run owning migrations before starting the API.

Pinned Workspace alone calls `POST /internal/workspaces/{workspaceId}/deletions/{deletionId}` with
`{meetingId,sourceVersion}`. Matching replay is safe; changing a recorded target/revision conflicts.
Cleanup requires a signed owning-service capability, not a still-active deleted content session.
It grants no meeting reads. Tenant IDs must match the delegated service actor.

The participant commits its deny tombstone **before** contacting OpenFGA. Policy checks consult it
both before remote evaluation and before returning an allow, so stale contextual ACL facts and
in-flight checks cannot resurrect a deleted meeting. Database/engine outages fail closed. Existing
policy uses contextual tuples only and does not persist relationship projections. Future persistent
projection writers must also enforce this barrier; adding an unguarded tuple writer is prohibited.

The purge reads only the exact `meeting:{workspaceId}/{meetingId}` object in a pinned store, deletes
only those verified tuple keys, and confirms an empty higher-consistency read before acknowledgement.
Workspace member tuples and other meetings are not removed. A request processes at most ten pages
of 100 tuples within a three-second overall transport budget. Larger/outage cleanup remains pending;
Workspace's durable saga resumes it. It reads the first page again after deletion rather than using
a cursor whose positions might shift. On replay it rechecks the provider, even after a prior completed
purge, so restore reconciliation does not trust an old cleanup acknowledgement alone.

Response: `{deletionId,meetingId,participant:"authz",state:"complete"|"pending"}`. Completion is never
claimed while the provider purge is uncertain. Backups retain their separately disclosed retention;
restore must replay all Workspace tombstones and verify provider cleanup before opening reads.

Local verification uses real isolated PostgreSQL and test-created OpenFGA stores: deletion/replay,
exact-object purge, retained unrelated tuples, stale facts, post-evaluation barriers, provider outage,
tenant/caller rejection and cleanup after logout. Tests delete only the stores they created. Azure,
production private-network/OpenFGA credentials, restore rehearsal and full composition remain
independent release gates, not implied by these checks.

Provider semantics use the [official OpenFGA relationship API](https://github.com/openfga/python-sdk/blob/main/docs/OpenFgaApi.md)
and [official SDK write/delete behavior](https://github.com/openfga/js-sdk). Concurrent or missing
tuple deletions can fail; those failures are retried through bounded read-and-delete reconciliation,
not converted into a successful acknowledgement without a confirming read.
