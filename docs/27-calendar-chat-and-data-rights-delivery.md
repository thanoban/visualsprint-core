# Calendar, saved chats and data-rights delivery

Updated 2026-10-08. Follow [the current plan](PROJECT_PLAN.md), not historical multilingual or
browser-cookie instructions. This delivery is English-first. It does not provision cloud services,
change production OAuth callback URLs, deploy the branch or assert Fathom feature parity.

## Delivered code paths

| Workflow | Actual implementation | Remaining qualification |
|---|---|---|
| Calendar → capture | Signed OAuth actor ownership; authoritative calendar snapshots; owned meeting, occurrence, quota reservation and scheduled dispatch outbox; cancellation/rescheduling/overrides | Real OAuth accounts and authoritative calendar events; continuous scheduler and capture worker hosting |
| Instant capture | Project-assigned or owner-private meeting created atomically with durable capture intent; idempotent retry; status/freshness/stop UI | Configured Vexa + STT and consented real Meet/Zoom/Teams calls |
| Project/customer saved chats | Creator-private saved threads; leased answer worker; validated, revision-bound citations; current access rechecked before publishing and reading; paged restore/retry UI | Real model credentials, answer-quality evaluation, authenticated browser E2E |
| Export | Durable text-manifest worker; authenticated, revision-checked download; bounded scope; 24-hour cache expiry | Large-workspace paging/streaming exports and operational storage qualification |
| Deletion | Immediate read tombstones; capture stop intent; independently verified provider/blob/secret cleanup; checkpointed retries; FK-ordered primary-store purge and receipt | Live provider erasure, backup expiry, storage inventory and in-flight-worker outage drills |

### Capture corrections

- Vexa `POST /bots` now includes required `platform` and `native_meeting_id`, plus the original
  invitation URL. The original Zoom URL preserves its encrypted invitation password; the adapter
  does not pretend that encrypted `pwd` is a plain meeting password. Teams `p` is forwarded when present.
  See the [official API guide](https://docs.vexa.ai/user_api_guide) and
  [upstream Zoom contract issue](https://github.com/Vexa-ai/vexa/issues/1630).
- Requests record intent, not success. Provider admission, stale contact, absent transcript and
  confirmed stop remain distinct states. `live_join_verified` is deliberately not inferred from
  a configured key, an API 202, a health endpoint or mock tests.
- Pilot calendar events use the durable provider lane, not a second legacy bot/recording transport.
  Existing events with legacy transports are marked for drain rather than silently duplicated.
- Calendar owners come from signed user identity, not guessed provider email. Historical unowned
  connections must reconnect before unattended capture. Disconnect disables scheduling and cancels
  pending work without deleting referenced occurrence history.
- The inherited calendar schema still permits one Google and one Microsoft connection per workspace,
  not an arbitrary team calendar fleet. Calendar-created meetings remain owner-private in Unassigned
  until explicit project assignment. Only instant capture from a project assigns it automatically;
  customer/project inference from event attendees is not implemented by this slice.
- Rescheduling a queued event cancels its old intent and releases its reservation. Removing a future
  event from an authoritative window cancels only that connection's relevant occurrence.
- Scheduled end is an estimate, not a signal to stop an ongoing meeting. Manual stop disables capture
  for that occurrence so the next calendar sweep cannot automatically restart it. Departure still
  requires provider confirmation.
- Dispatch rechecks current membership, meeting visibility, calendar ownership, disclosure and capture
  policy. Workspace concurrency limits and monthly reservations are applied before provider creation.
- Reservation expiry covers scheduled start plus estimated duration and a grace period. Actual usage
  is reconciled by the existing provider lifecycle; this is not proof of provider billing accuracy.
- Rejected/duplicate manual intake removes its own provisional URL secret. Calendar policy/quota
  rejection removes unused URLs. Cleanup failures still require SecretStore inventory reconciliation.
- Provider credentials are versioned on rotation. A failed configuration attempt cannot delete the
  previously active credentials. The binding's upstream account identity cannot be switched in place:
  existing immutable record IDs must not suddenly resolve against another account.

### Saved conversation behavior

Create/open a private project or customer, choose **New chat**, and ask a question. Sending saves
the user message, pending answer and outbox intent in one transaction. A separately running worker
retrieves only currently accessible, verified/partially-supported statements with transcript evidence.
The model selects evidence IDs; it cannot publish unchecked factual prose. The saved answer includes
coverage limits and report citations. Removed membership, moved meetings or corrected source text
invalidate the prior answer projection rather than merely hiding its citation chips.

This first lane is explicitly a **cited evidence answer**, not unrestricted ChatGPT-style synthesis.
It reads up to eight prior user questions, ranks up to 200 candidate statements, includes at most 60
statements/32,000 characters and selects at most 20 supported statements. It does not claim to recall
every raw transcript or summarize an arbitrarily large customer history exhaustively. Higher-quality
structured synthesis, exhaustive long-history workflows, hybrid retrieval evaluation and SSE are
still feature/qualification gates. Project/customer scope is implemented; meeting-only threads are not.

Messages restore in chronological pages of at most 100 with an ownership-checked `(created_at, id)`
cursor. Older/Newer buttons retain history beyond the latest page. Thread-directory pagination beyond
its existing 100-thread cap remains a large-workspace gate. All answer workers use fenced leases,
bounded model timeout, three attempts, safe error codes and LLM-call accounting. Failed attempts for
which the provider supplies no token usage cannot prove complete billing reconciliation.

### Export and deletion semantics

Exports contain current accessible transcripts and verified knowledge, never media download URLs.
A workspace owner does not bypass private-project membership. Downloads require the original creator,
current scope access, unchanged source digest and unexpired manifest. Limits are explicit: 100 meetings,
10,000 utterances and 2,000 verified items per capture, and a 10 MB manifest. Oversize exports fail
visibly instead of presenting silently truncated output as a complete export.

Deletion requires project owner or workspace owner, an explicit confirmation in the UI and a durable
job. Content is hidden immediately. The worker waits for capture departure, deletes provider artifacts,
checks transcript absence independently, verifies blob/secret absence and then purges primary rows.
Provider/media cleanup checkpoints survive a database failure, including retries after credentials or
media locator secrets are removed. Credentials/configuration still referenced by another workspace
are preserved. Legacy active bots cause a visible stop-required receipt; they are not magically stopped.

Project deletion removes its assigned meetings and private chats. Other projects/workspaces are not
purged. Legacy person aggregates and voiceprints with insufficient provenance are conservatively
invalidated within the workspace, and affected customer answers/summaries are invalidated. Workspace
deletion retains only its minimized workspace/deletion receipts and the user's global login; it does
not delete that person's other workspaces. Receipt links remain creator-readable after content removal.

Failures keep content hidden and expose retryable receipts. Eight automatic cleanup attempts are
bounded; the creator can retry an accepted failed deletion. The legacy synchronous meeting export/
deletion endpoints reject founder-pilot/durable-capture meetings and direct users to `/operations`.
Old pending job rows without outbox intents are not automatically executed or declared complete.

`DONE` concerns verified primary stores, not historical backups, downloads already saved by users,
platform-native recordings outside the provider contract, approved external tasks, third-party logs
or legal/compliance certification. Those require separate retention/inventory policies and evidence.

## Runtime wiring — no production URL changes

`infra/docker-compose.yml` adds an opt-in `founder` profile with three independent durable workers.
API and workers share the local BlobStore and SecretStore volumes. Migration startup precedes worker
startup through the API health dependency. The existing analysis worker supplies calendar sweeps and
processes the transcript → understand → verify → memory → report pipeline. A tombstoned meeting is
not regenerated by a later queued pipeline job.

The profile has **not been started against user accounts in this delivery**. After reviewing costs,
configuring consent and selecting an actual supported provider runtime, an operator can start it:

```powershell
docker compose -f infra/docker-compose.yml --profile founder up -d --build
```

The profile does not install or provision Vexa/STT. Configure a dedicated provider account with the
authenticated owner/admin `PUT /api/v2/workspaces/{org}/capture-provider/vexa` endpoint:
`endpoint_url`, `api_key`, `account_scope_id`. Use a reviewed HTTPS endpoint reachable by the workers;
Docker's localhost refers to that container, not the Windows host. Keep credentials outside Git/logs.
Do not silently share one upstream account among unrelated workspaces. Connect/reconnect Google or
Microsoft Calendar in Connections, review disclosure, enable the pilot and choose calendar policy
through onboarding. None of these steps proves a real call was captured.

For an already configured Python environment, entrypoints also support bounded runs or supervised
watch mode; do not start them merely to test their imports:

```powershell
cd backend
.\.venv\Scripts\python.exe -m app.capture.worker --watch
.\.venv\Scripts\python.exe -m app.entrypoints.conversation_worker --watch
.\.venv\Scripts\python.exe -m app.entrypoints.data_rights_worker --watch
```

Run watch processes in separate supervised terminals/services. The analysis/scheduler worker must
also run. The three new loops are not automatically added to the existing production Cloud Run
worker. Production needs an explicitly reviewed deployment with meeting-lifetime availability,
configured storage/credentials, recovery and billing controls. Local `.env`/OAuth URLs are not changed.
Existing ephemeral local secret files are not silently copied into the new named SecretStore volume.

## Verification record

Tests use isolated local PostgreSQL/pgvector
databases and mocked calendar/provider/model/storage dependencies, never consentless live meetings.
The disposable gate container is `visualsprint-project-gate-20261008`, loopback port 55434. Tests
disable disk synchronization only there for speed; these runs do not prove crash durability.

The initial full run stalled on the stopped default local database and was stopped. A repeat against
the isolated database produced 930 passes, four skips and one stale reservation-expiry assertion.
That assertion was corrected to the new scheduling contract, with an additional future-start test.
One new stop test initially expected 200 rather than the endpoint's documented 202; it was corrected.
A pagination UI change initially failed TypeScript's unchecked-index check; the guard was corrected.
These failed attempts are not presented as passing evidence.

Successful gates:

- Full backend suite against separate PostgreSQL API and migrated pipeline databases: **942 passed,
  1 skipped**, 424 seconds. No schema-dropping fixture was pointed at the pipeline database.
- After the final provider-rotation and legacy-rights hardening, a separate PostgreSQL delta suite:
  **58 passed**, 61 seconds. Includes calendar/manual intake, saved answers/paged restore, cleanup
  recovery, provider configuration, legacy rights, current-user reads and scheduled reservations.
- Fresh empty PostgreSQL database: entire Alembic chain applied through `n5b6c7d8e9f0`; `alembic check`
  reports no new upgrade operations. The retained pipeline database also passed the drift check.
- Backend Ruff passed. Strict rule-enforcement modules passed the mypy gate; the measured whole-app
  backlog fell from 216 to **212** and the ratchet was lowered. This is not whole-app strict cleanliness.
- Frontend client-contract tests: **6 passed**; ESLint, TypeScript and production build passed,
  including the new calendar, operations and saved-conversation surfaces. No browser E2E performed.
- All three new worker `--help` entrypoints loaded; `docker compose --profile founder config --services`
  parsed the independent-worker composition without starting it. No daemon consumed real user jobs.

Publication is a source checkpoint on `codex/founder-platform-plan`, not a deployment. The existing
quality workflow runs on PRs/main or manual dispatch; pushing this feature branch alone does not
constitute a completed GitHub Actions run. No main merge or paid deployment is performed here.

## Release gate — still not Fathom-ready

1. Pin/review Vexa and STT builds, provider concurrency/resource cost, retention and supported invitation
   variants; prove actual transcript flow for consented Meet, Zoom and Teams calls. No guest bot can
   bypass host admission or a provider/platform access restriction.
2. Prove calendar schedule, join, admission, capture, end-of-meeting departure and exactly-once final
   transcript/report with real accounts, including meeting overruns, rescheduling and disconnection.
3. Run authenticated browser E2E for project capture/status, restored chats, corrections/access
   revocation, export and deletion receipts. A build and client tests are not interactive acceptance.
4. Exercise outage, ambiguous dispatch, lease expiry, concurrent workers, model budget pressure,
   storage failure and cleanup deadlines with production-equivalent infrastructure. Validate tenant
   quotas under concurrency; the workspace limit is not a qualified fleet-wide capacity planner.
5. Qualify backup expiry, orphan-secret/media inventory, in-flight legacy work and real artifact erasure.
6. Complete remaining F00–F14 acceptance items from the plan. This provider lane captures English text,
   **not screenshots/video**; the existing upload screen pipeline is not proof of unattended screen
   capture. Temporary recording, visual evidence, whole-history synthesis, integration side effects and
   competitor parity must not be marked delivered from these local results.

No production migration, deployment, paid GCP provisioning or OAuth URL replacement is authorized
by this development checkpoint. The next useful external step is an explicitly consented staging
provider qualification session, with results recorded per platform rather than a blanket success label.
