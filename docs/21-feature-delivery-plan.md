# End-to-end feature delivery plan

Status: APPROVED FOR INCREMENTAL IMPLEMENTATION. Updated 2026-10-07.
This is the ordered development backlog. Each feature includes API, UI, persistence, permissions,
failure paths and verification; a feature is not done until all applicable parts pass.
Architecture: [18](18-founder-platform-architecture.md). Code structure: [20](20-engineering-design.md).
Contracts: [22](22-data-and-api-contracts.md). Release gates: [23](23-testing-and-operations.md).

## Delivery rules

- Implement one numbered slice at a time; development resumed on 2026-10-07.
- Changes must be independently reviewable and additive; use feature flags for unfinished paths.
- Do not replace the entire application in a single patch or make placeholder pages imply readiness.
- Local tests, provider contract tests, live meeting tests and production readiness are separate gates.
- No paid resource creation or production migration is part of documentation approval.

## F00 — Repository and migration baseline

Outcome: a reproducible starting point with preserved user work and consistent docs.
Inventory tracked/untracked changes, dependency locks, routes, migrations, CI and deployed services.
Record exact baseline checks without rewriting historical success counts. Keep the new design under
a feature branch; stage only owned changes. Existing proof-of-concept adapter code remains unmerged
until reviewed against these contracts. Establish separate local/staging databases and deterministic
fixtures; retain legacy reports and capture modes behind compatibility boundaries.

Done: approved schema/API plan, isolated test environment, baseline result, rollback branch and no
unintended code/dependency/secret changes. Depends on: documentation acceptance and resume instruction.

## F01 — Workspace identity and onboarding

Outcome: founder signs in, creates a workspace and completes capture preferences without repeated login.
Retain existing auth; implement owner/admin/member roles, secure session refresh coalescing, member
invitations and removal. Capture is off until the owner chooses a policy and acknowledges disclosure.
Store timezone, preferred language (English pilot), retention and capture limits.

UI: onboarding checklist, workspace selector, members/settings. Failures: expired/revoked grant,
provider outage and unauthorized workspace switching. Never treat a transient refresh error as proof
the user must sign in again. Done: role matrix and concurrent refresh tests pass; private projects
are not exposed by generic workspace membership. Depends on F00.

## F02 — Customers, contacts and projects

Outcome: create Acme customer, associate contacts, create a project, add private project members.
Add schema/CRUD/list/archive for customers and projects; internal projects have no customer.
Default new projects private. Archiving prevents new automatic assignment but preserves accessible
history. Customer listing/summary only reveals authorized projects, not inaccessible project counts.

UI: customer directory, customer timeline, project sidebar/settings, Unassigned inbox.
Validation: duplicate names allowed with distinct IDs; confirmed contact rules unique within their
scope; shared consumer email domains never auto-identify a company. Done: create/edit/archive,
membership removal and cross-tenant/project negative tests. Depends on F01.

## F03 — Calendar connections and event occurrences

Outcome: connect Google or Microsoft once; upcoming events remain synchronized.
Use existing OAuth callbacks and SecretStore. Add notification renewal, incremental cursor storage,
periodic reconciliation, calendar selection and per-event capture overrides. Normalize UTC times
while displaying workspace timezone; identify recurring occurrences independently from meeting URL.
Cancellation/reschedule updates pending requests. Ignore deleted/private/declined events according
to explicit policy. Never infer "record every event" from an unknown policy value.

UI: upcoming meetings, capture enabled/disabled reason, connection health, reconnect action.
Done: DST/recurrence/cancel/change tests; duplicate notification replay creates one occurrence;
revocation is visible; calendar callbacks do not run bot capture themselves. Depends on F01/F02.

## F04 — Vexa qualification and durable capture requests

Outcome: one capture request creates at most one controlled attempt for a meeting occurrence.
Qualify pinned Vexa against actual Meet/Teams/Zoom invitation forms and document unsupported policies.
Implement provider port, credentials per workspace, request/attempt tables, budget reservations,
transactional outbox, leased dispatcher and idempotent create API. Preserve passwords in secret
material and exclude them from user-visible errors. Enforce five-bot pilot concurrency.

UI: paste link, choose project, see queued/joining/admission state. No extension installation required.
Failures: missing credentials, STT unavailable, quota, duplicate dispatch, connection loss after POST,
host denied, unsupported account policy. Ambiguous creation requires reconciliation, not blind retry.
Done: contract fixtures plus real accepted/rejected meetings; no false recording state; no cross-tenant
reuse of provider records. Depends on F01/F03; manual-link testing can precede calendar rollout.

## F05 — Live status, stop and restart recovery

Outcome: founders know whether capture is happening and can stop it reliably.
Implement signed event inbox or authenticated polling, normalized state history, transcript freshness,
last-provider-contact time, retry state, stale-capture alerts and idempotent stop requests.
Use 60-second empty-room grace, ten-minute lobby timeout and four-hour maximum. Do not stop merely
because the calendar end passed or the founder left while other participants continue.

UI: live badge, waiting-for-host explanation, last received text time, stop button and partial-data
warning. Done: duplicate/out-of-order events, API/worker restart, stop/create races, recurring URL reuse,
host removal, provider disconnect and meeting overrun tested. Depends on F04.

## F06 — Temporary media, transcription and speaker labels

Outcome: canonical English transcript with original times, safe retention and explicit coverage gaps.
Choose one qualified lane per capture: provider transcript with verified speaker timing, or temporary
audio plus Groq. Implement Vexa STT bridge only against its documented protocol; plain Groq URL wiring
is insufficient. Reconcile draft/final segments, split long files with offset preservation, normalize
language/confidence and keep unknown speakers unknown. No voiceprints in pilot.

Retention: delete after successful transcript verification, hard deadline no later than 24 hours from
capture start, failure included. Delete provider and application copies; configure storage versions and
backup exclusions. Persist deletion attempts and overdue state. Audio recording stays disabled until
this entire lifecycle passes. Done: labelled English samples, overlap/silence/accents, endpoint
outage, retry cost, malformed media and hard-deadline deletion tests. Depends on F05.

## F07 — Meeting detail, verified summary and correction

Outcome: opening an ended meeting shows transcript, cited summary, decisions, actions and gaps.
Extract atomic claims, verify independently, generate a versioned report from accepted statements.
Publish the report before optional customer analytics/integrations. Transcript correction produces
a revision and reprocesses only affected knowledge; user edits remain distinguishable from ASR.
No automatic guess of person, commitment owner or date.

UI: overview/transcript/actions tabs, clickable timestamps to text, language/coverage labels, correction
flow and processing status. No dead video player when recordings are intentionally unavailable.
Done: citation support, hallucination adversarial tests, empty meeting, partial capture, correction
propagation, retry idempotence and permissions. Depends on F06.

## F08 — Meeting assignment and customer history

Outcome: meetings accumulate under the correct customer/project without data mixing.
Explicit assignment wins; approved contact/organizer rules next; ambiguous matches stay Unassigned.
Owners can move meetings they own into projects they can contribute to. Sharing implications are
shown before assignment; target membership never silently expands from participants in the meeting.
Moving/deleting invalidates source/target memory and caches. Recurring meeting rules apply to future
occurrences, not retroactively without confirmation.

UI: assign/move picker, suggestions, customer/project timelines and filters. Done: two customers with
overlapping contacts, consultants, Gmail users, multiple projects, membership revocation and moved
meeting tests. Depends on F02/F07.

## F09 — Project/customer memory and decision tracking

Outcome: "what has happened with Acme?" covers the authorized meeting history chronologically.
Maintain versioned summaries and typed decision/commitment/question records with source links,
supersession and contradictions. Update incrementally after meeting/correction/deletion events.
Open/closed action state requires supported evidence or explicit user confirmation; silence is not
completion. No employee performance scoring or invented personality conclusions.

UI: current context, timeline, changed decisions, requirements, unresolved questions, outstanding
commitments. Done: multi-meeting sequence fixtures, contradicted decisions, large history, stale
versions and permission-filtered aggregates. Depends on F08.

## F10 — Persistent project and customer conversations

Outcome: ChatGPT-like saved threads within projects and customers, with grounded answers.
Add thread/message APIs, streamed answers, bounded history and source references. Retrieval filters
by workspace AND permitted meetings before FTS/vector/graph expansion. Whole-history summary mode
enumerates authorized summaries; factual questions use ranked evidence. Wire real LLM/embedder
factories; fail visibly when unavailable. Persist generation state and retry identity.

UI: project thread sidebar, create/rename/archive thread, conversation restoration, citations and
clear "not found in captured meetings" answers. Customer chat aggregates only accessible projects.
Done: follow-up questions, reconnect, duplicate send, deleted sources, revocation, no-answer cases,
prompt injection and cold-start model failures. Depends on F09.

## F11 — Next-meeting agenda and founder preparation

Outcome: before a customer meeting, the founder sees context and a useful agenda.
Build from upcoming objective, participants, latest memory, unresolved questions and commitments.
Generate 24 hours before, refresh 15 minutes before if inputs changed, or on demand for late events.
Separate evidence-based context from proposed discussion topics. Preserve user edits across refresh;
show a proposed new version instead of overwriting them.

UI: editable agenda, source links, private notes and export/copy. No auto-email to attendees.
Done: new customer with no history, reschedule/cancel, user edit conflict, timezone, changed decision
and deleted evidence tests. Depends on F03/F09/F10.

## F12 — Approved integrations and follow-through

Outcome: founder can approve a meeting-derived Jira/Linear/GitHub task or follow-up draft.
Retain approval enforcement; approved payload is versioned and immutable for execution. Record
connector account, destination and external result ID. Timeouts reconcile by idempotency/external
lookup before retry. Revoked permissions request reconnection; one integration failure does not
invalidate a completed meeting summary. Start with existing connectors; Slack/CRM next.

UI: proposal queue, evidence, edit/approve/reject, destination selector, execution status and retry.
Done: double approval, permission revocation, external timeout, edited payload invalidating approval,
rate limiting and duplicate webhook tests. Depends on F07/F09.

## F13 — Usage, retention, export and operations

Outcome: bounded spend, clear connection/capture health and reliable deletion.
Display hours used/reserved, estimated vs reconciled costs, limits and failure reasons. Block new
requests at limits with actionable messages. Provide transcript/summary export, project deletion,
workspace deletion and audit status. Meter provider waiting/runtime, ASR, model tokens and retries.
Developer/admin operations expose IDs and error codes, not meeting content by default.

UI: settings/usage, data rights, capture diagnostics, connection health. Done: reservation races,
expired reservations, dropped events, cleanup failure, export permission and cascaded delete tests.
Depends on F04-F12; minimum usage/retention protections are prerequisites of earlier live capture.

## F14 — Pilot release

Outcome: five founders can use the entire loop with known costs and support procedures.
Run the full platform/admission matrix, five concurrent calls, four-hour soak, outage/restart drills,
customer isolation, privacy cleanup and full founder scenario from [23](23-testing-and-operations.md).
Deploy per workspace behind a flag; legacy active captures drain without duplicate replacement.
Track join success excluding host refusals separately from overall customer success. Record costs
and latency distributions. Only then advertise platform coverage and availability.

## After the pilot

| Feature | Entry gate | Architectural home |
|---|---|---|
| Sinhala/Tamil/code-switching | Labelled native-language accuracy + provider cost evaluation | Transcripts/adapters |
| Optional screen evidence | Explicit product/privacy choice, capture capability and retention tests | Capture/knowledge |
| Native desktop companion | Confirmed demand for bot-hostile meetings; device qualification | Separate client + capture port |
| CRM enrichment/sync | Correct customer identity and approved write reconciliation | Customers/integrations |
| Founder digests and trends | Reliable memory versions and permission-aware aggregation | Knowledge/agendas |
| Mobile/in-person capture | Explicit scope change, device/media lifecycle tests | Capture client |
| Service extraction | Measured scaling/isolation need, not feature count | Selected module ports |

No future feature is implied by a checkbox, placeholder route or third-party marketing claim.
