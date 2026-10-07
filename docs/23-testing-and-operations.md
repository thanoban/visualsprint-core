# Testing, deployment, cost and operational acceptance

Status: ACTIVE ACCEPTANCE MODEL. No production deployment or paid resource creation is authorized by this document alone.
Updated 2026-10-07. Feature gates: [21](21-feature-delivery-plan.md).

## 1. Four evidence levels

1. Unit/contract tests prove deterministic behavior against controlled fixtures.
2. Local integration tests prove real PostgreSQL, migrations, workers and application boundaries.
3. Staging live meetings prove provider/platform behavior with consenting participants.
4. Pilot production measurements prove behavior on actual customer configurations and traffic.

Every status report states which level passed. A health endpoint, API key, green CI run, fake meeting,
published commit or provider marketing page alone does not prove end-to-end capture.

## 2. Automated verification matrix

| Area | Required cases |
|---|---|
| Authentication | Expired/revoked tokens, concurrent refresh, transient provider error, org switching |
| Authorization | Cross-org IDs, private project, customer aggregation, hidden graph neighbor, revoked thread access |
| Calendar | Recurrence, timezone/DST, cancelled/rescheduled event, duplicate notification, revoked grant |
| Dispatch | Two simultaneous creates, idempotency payload conflict, quota race, timeout after accepted POST |
| Lifecycle | Unknown state, duplicate/out-of-order event, signed-event replay, worker crash, stale lease |
| Stop | User stop, empty room, host end, founder leaves first, recurring-link race, maximum duration |
| Transcript | Final/draft revisions, missing segments, malformed times, repeated text, overlapping speakers |
| Retention | Successful cleanup, failed processing, lost callback, provider 409/404, overdue deletion, backups policy |
| Knowledge | Unsupported claim, contradiction, correction, stale summary publish, missing evidence |
| Chat | Persistent history, retry duplicate, prompt injection, insufficient evidence, source permission loss |
| Agenda | New customer, edited agenda, reschedule, cancelled event, changed source revision |
| Integrations | Double approve, changed payload, timeout ambiguity, revoked permissions, rate limit |
| Usage | Reservation release, real usage reconciliation, concurrent cap, waiting time, duplicate billing event |

Use local PostgreSQL+pgvector for locking/uniqueness/RLS or permission-boundary tests. SQLite cannot
prove production locking behavior. Fixtures use separate test databases; tests never drop application
or production tables. Mock network providers in normal CI and prevent live billing credentials from
entering test jobs. Contract fixtures pin the provider release and include adverse responses.

## 3. Product end-to-end scenario

Create founder workspace -> connect selected calendar -> create Acme and two projects -> schedule
three customer meetings with differing attendees -> bot joins admitted meetings -> verify full
transcripts and gaps -> approve project assignment -> open cited summaries -> change a transcript
term -> confirm summary/memory revision -> ask project follow-up questions in a saved thread ->
reload browser and continue -> ask customer-wide summary -> prepare next-meeting agenda -> edit it
-> approve one Jira/Linear/GitHub action -> confirm one external item -> remove project access ->
verify hidden evidence cannot be recovered from memory/chat -> delete one meeting and verify cleanup.

Negative control: create a second workspace/customer using similar names and the same consumer email
domain. None of their text, counts, citations, tasks or provider recordings may cross the boundary.

## 4. Live capture qualification

Run on Google Meet personal Gmail and Workspace, Teams personal/work accounts and Zoom supported
host/account configurations. Record browser/client versions, provider digest, region and account policy.
Test direct admission, host admits, host refuses, lobby timeout, authenticated-only room, host absent,
wrong passcode, changed link, cancelled meeting and late start. Some configurations will be unsupported;
publish the measured support matrix rather than hiding refusal as a code error.

Run normal conversation, long silence, two-person overlap, screen presentation (no image retention in
pilot), poor connection, participant join/leave, host removal, everyone leaves/rejoins within grace,
and a meeting continuing beyond calendar end. Include five concurrent meetings and a four-hour soak.
Restart the API and workers mid-meeting; kill a capture process in staging and verify an honest gap.

Acceptance targets (targets, not current measurements):

- One bot per workspace occurrence; zero duplicate external task creation.
- Join-success rate measured separately for eligible admitted meetings and all requested meetings.
  Pilot gate: at least 19/20 eligible trials per platform; report small sample size, never call it an SLA.
- Status UI within ten seconds of a received provider update; disconnected provider freshness visible.
- End/empty-room departure within 90 seconds under normal provider connectivity.
- Final cited summary within two minutes after final transcript availability at p95 pilot load;
  project memory within another minute. Track meeting-end-to-final-transcript separately.
- Zero known tenant/project leaks; every displayed factual summary claim has resolvable authorized evidence.
- Temporary media removed by the 24-hour hard deadline, including failed jobs, across configured stores.

Transcript evaluation uses consented human-labelled English samples covering accents, names, numbers,
dates and commitments. Record WER plus entity/owner/date correctness and speaker attribution separately.
Go/no-go requires no unsupported owner/date assignments in the acceptance scenarios and manual review
of remaining errors. Sinhala/Tamil/mixed-language claims require their own datasets and thresholds later.

## 5. Deployment and environment boundaries

Local: existing app services and a disposable test database; provider contract fakes by default.
Staging: isolated database/secrets and pinned Vexa release, consented test accounts only.
Pilot: same immutable application artifact promoted after gates; workspace feature flag enables new capture.

Do not run bots in request-lifetime background tasks or use ephemeral process dictionaries as the only
record. Capture processes need meeting-lifetime capacity. Scheduler and capture reconciliation remain
available independently of slow analysis. Vexa services and datastore needs are part of sizing.
Do not mount developer subscription credentials, home directories or an unrestricted Docker socket
into the application API. Use the minimal meeting deployment and restrict provider network exposure.

Initial proposed topology: modest Linux application/worker host, isolated capture runtime, managed
PostgreSQL/auth and HTTPS ingress. It is not highly available by default. If using existing Cloud Run,
keep public service URLs and OAuth callbacks stable and explicitly provision worker/capture lifetime
semantics; GenAI credits do not establish eligibility for compute. No migration of hosting just to
change technology before a cost/latency benchmark exists.

## 6. CI and release workflow

Per slice: lint, type checks, scoped unit/contract tests, PostgreSQL integration where relevant,
migration upgrade and compatibility checks, frontend type/lint and behavioral tests for user flows.
Run the full affected suite before release. New errors cannot be hidden by raising historical baselines.

Build backend and frontend artifacts independently when their paths change; reuse dependency layers.
Use a staging preview and fixture replay for fast iteration. Do not redeploy production for every small
test. Verify actual artifact SHA/config revision after deployment. Database migrations run once under
a deployment lock; additive rollout precedes application use of new fields.

Rollout: internal workspace -> one founder -> five-founder pilot -> wider launch. Old active captures
drain. Disable their future dispatch for opted-in workspaces so both old and new providers never join.
Rollback disables new dispatch, allows active calls to finish if safe and restores the previous app
version; it does not automatically discard newly stored transcripts/customer data.

## 7. Monitoring and recovery

Correlate request, workspace, meeting, capture attempt, provider record and job IDs. Structured error
codes, retries, durations and stage names are sufficient for normal logs; exclude raw content/secrets.
Measure queue age, lease expiry, provider freshness, admission outcome, transcript segment rate,
summary latency, cleanup deadline, OAuth health and per-meeting cost.

| Signal | Default operational response |
|---|---|
| Dispatch unknown | Reconcile provider account/occurrence; never automatically resend create |
| No status contact for 60 seconds | Show stale state; retry status with backoff; alert after five minutes |
| Capturing with no transcript | Check STT/coverage; silence alone is not failure or proof of recording |
| Lease expired | New worker claims with new fencing version; stale worker cannot publish |
| Provider quota hit | Pause new dispatch, preserve reservations appropriately and show reason |
| OAuth revoked | Mark reconnect_required, stop future scheduling for that connection |
| Cleanup deadline within one hour | Prioritize deletion and alert operator; do not wait for summary work |
| Cleanup overdue | Incident state; retry and restrict new temporary-recording captures |
| Cost reaches 80% configured cap | Notify owner; include reservations and projected scheduled work |
| Cost cap reached | Refuse new capture with explanation; active calls retain planned end behavior |

Provider outage must degrade the UI honestly. No synthetic summary or empty-success transcript.
Dead-letter jobs have operator-visible safe reasons and a controlled requeue path; requeue preserves
idempotency and does not bypass an approval or a deleted scope.

## 8. Costs and limits

Agreed target: five founders, 100 total meeting hours/month, five concurrent captures, English.
Software preference is Apache/MIT/BSD-compatible components where applicable; audit transitive
dependencies and image license exceptions. Free software does not remove CPU/storage/maintenance cost.

Planning allowance (USD/month, not a quote): capture/app servers $20-50; managed database/auth $25;
Groq Turbo 100 audio hours about $4; AI $5-15; backups/misc $5-10. Approximate total $60-105.
The five-bot hardware gate may raise it. Excludes tax, labor, support and redundancy. Hosted Vexa
capture is advertised at $0.30/bot-hour plus $0.20/hour transcription; Recall $0.50 + $0.15.
Recheck prices before procurement; [18](18-founder-platform-architecture.md) records sources.

No mandatory GPU. Compare Groq API cost with measured self-hosted ASR compute; tiny.en quality is not
an acceptable cost shortcut. Bound model context, cache versioned summaries and update only changed
customer memory. Do not send all previous transcripts on every chat question.

Runtime defaults: limit hours and concurrency; paid provider activation requires an explicit configured
budget and credential binding. Do not invent an approved spending amount from a planning estimate.
Application spending caps are best-effort admission controls, not guaranteed provider invoice caps.

## 9. Completion record per feature

Record feature ID, commit/artifact SHA, migration IDs, tests and counts, live meeting evidence IDs,
measured limits, remaining gaps and rollback instructions in the progress ledger. Never replace
"not tested" with "should work". The planning set is complete and implementation is now active;
each slice must update this evidence record before it is called complete.
