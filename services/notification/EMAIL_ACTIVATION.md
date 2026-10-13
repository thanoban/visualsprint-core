# Activation checklist — verified recipient and Azure email

Account and Notification runtime wiring is implemented in this bounded slice. Configuration remains
optional and disabled by default. This checklist distinguishes local implementation from live delivery.

## 1. Review and activate Account migration

- Review `services/account/migrations/0004_verified_profiles.sql`; preserve existing production
  users, memberships and source tables.
- Account `0004` is active and applied only to the local qualification database. Never change an applied
  migration checksum. Notification `0002` distinguishes `provider_sent` from in-app `delivered` and
  normalizes old email send-status rows without claiming mailbox delivery.
- Apply with the migration role, then assert runtime is non-owner/non-superuser/non-BYPASSRLS.
- Enable `ACCOUNT_PROFILE_TEST_ENABLED=true` for the gated owning PG tests. When unset, those five
  tests explicitly skip; a green skipped suite is not projection qualification.

Focused local verification after activation (PowerShell):

```powershell
$env:ACCOUNT_PROFILE_TEST_ENABLED = 'true'
pnpm --filter @visualsprint/account test:integration
Remove-Item Env:ACCOUNT_PROFILE_TEST_ENABLED
```

Use `try/finally` or restore the prior flag value in an automated runner. This flag gates tests only,
not production membership authorization, email verification or migration activation.

Tests cover persistent verified/unverified results, normal logout, out-of-order refreshes, stale
provider revisions, changed subject, outage without cached-email fallback, membership revocation
between lookup and save, cross-actor isolation and the runtime-role baseline.

## 2. Wire Account's optional profile capability

- `AccountService` now accepts optional Account-owned `NotificationProfiles`.
- In `notificationMembership`, preserve the current self-recipient-only/current membership/workspace
  barrier; request `profiles.forActor(actor)` only through the optional configured adapter.
- Complete the external lookup outside Account's membership transaction and recheck current
  membership/workspace authority before publishing `{active:true,verifiedEmail}`.
- If no configured profile provider exists, retain `verifiedEmail:null` without a projection query.
  Do not read a persisted email as an outage fallback.
- Account main instantiates `configuredProfiles(pool, WORKOS_PROFILE_API_KEY)` from the private
  server configuration. Store the API key only in Key Vault/server environment, never public Vite
  env, logs, event envelopes or user API bodies.

## 3. Wire Notification's optional managed-identity adapter

- Notification runtime uses `configuredEmail` with optional `AZURE_EMAIL_ENDPOINT`,
  `AZURE_EMAIL_SENDER`, `WEB_APP_ORIGIN`, `AZURE_CLIENT_ID` and explicit local-CLI opt-in only.
- An absent endpoint/sender pair preserves `DisabledEmail`. An incomplete pair fails startup;
  it must not silently choose a fallback provider or arbitrary sender.
- Optional `EmailPort.prepare()` acquires the bounded MI token before recording the
  external-send intent; then recheck current preferences, member/source access and verified email.
- Send intent is persisted before the POST; every attempt remains fenced by its durable delivery ID.
  The intent transaction uses the same per-recipient lock as preference changes and checks email
  consent/scheduled availability again. Opt-out before intent cancels pending work; intent committed
  before opt-out is already potentially external and remains lookup-only if its outcome is uncertain.
- Running/unknown/missing status remains lookup-only. No generic retry repeats a POST after uncertainty.
- Internal `provider_sent` means provider send-operation success, not mailbox delivery.
  Actual delivered/bounced receipts need separately authenticated, qualified provider events.

## 4. Verify without external effects first

- Run the owning fast and database tests, native builds and boundary checks.
- Controlled adapter and owning PG tests are present. A deployment composition qualification with
  controlled WorkOS and Azure transports must additionally verify the complete signed
  Account → Notification profile path and preserved logout/revocation behavior.
- Exercise disabled and incomplete configuration so queued/held states remain actionable and do not
  initiate repeated login, account reconnection or duplicate email.
- Root publishes only the reviewed owned slice after all applicable checks; no source change in this
  checklist performs a provider request or provisions a billable resource.

## 5. Live release gates require separate authorization/configuration

Cost approval, actual verified WorkOS profile, Azure sender/domain linkage, deployment managed-identity
role, sender quota, staging recipient consent, send-operation success and delivery/bounce telemetry
remain external qualification. Follow the sourced setup/cost worksheet in [EMAIL_SETUP.md](EMAIL_SETUP.md).

## Local activation evidence — 2026-10-13

Account and Notification typechecks passed. Account has five passing fast tests and fourteen passing
owning PostgreSQL/HTTP tests, including all five explicitly enabled profile tests (zero skips).
Notification has six passing fast tests and twelve passing owning PostgreSQL/HTTP tests. Controlled
transport tests do not contact WorkOS or Azure. Both active migrations applied successfully to local
owning databases with runtime-role checks; no production database was changed.
Both native service builds, the service-import boundary check and scoped whitespace checks passed.

Notification regressions cover credential preflight failure before intent, source/member revocation,
changed/unverified destination after preflight, opt-out during the final remote source check, stale
worker cancellation fences, schedule changes before intent, future routing and `provider_sent` truth.
Previously committed send intent is deliberately not treated as cancelled/no-send proof on opt-out.
