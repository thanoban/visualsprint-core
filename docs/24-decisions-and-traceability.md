# Decisions, risks and requirements traceability

Status: active decision record. Updated 2026-10-07. Incremental implementation resumed;
production deployment and paid provisioning remain separately gated.

## 1. Accepted product decisions

| Decision | Source / rationale | Consequence |
|---|---|---|
| Founder/customer focus | Owner wants context across many customer meetings | Customer and project memory are core, not optional tags |
| Projects and saved chats | Owner requested ChatGPT-like organization | Server-persisted threads and scoped retrieval |
| Unattended bots | Explicit owner selection | No desktop/extension requirement for primary capture |
| Automatic capture | Owner clarified users will not upload audio | Calendar/paste-link scheduling drives capture |
| No permanent audio/video | Owner selection and clarification | Text-centric product; no player or permanent screenshots in pilot |
| Temporary audio allowed | Owner explicitly approved up to 24 hours | Recovery permitted only with deletion controls |
| English pilot | Explicit owner selection | Sinhala/Tamil remain future evaluated releases |
| Five founders / 100 hours / five concurrent | Explicit pilot selection | Test load and quota baseline |
| Lowest practical cost | Owner requested free/open-source where suitable | Qualify self-hosted capture and inexpensive inference |
| Architecture may change | Owner permits full redesign | Replace fragile capture ownership; retain useful tested boundaries |
| Documentation before code | Historical planning phase, followed by explicit development instruction | Plan approved; incremental implementation resumed, deployment separately gated |

Small paid pilot was selected, but a precise approved recurring spending ceiling has not been set.
All dollar amounts in the documents are planning allowances, not purchasing authorization.

## 2. Engineering decisions

**Modular monolith:** one application codebase with strict module contracts and separate worker entry
points. It supports incremental features without premature distributed transactions and service ops.

**Open-source capture candidate:** Vexa behind CaptureProvider. Its repository/license and current docs
make evaluation reasonable; they do not establish our measured reliability. Pin release and image digest,
test actual accounts, keep a replaceable adapter. Hosted fallback is an operator-controlled choice and
does not create a second bot automatically after an uncertain first dispatch.

**Low-cost inference:** Groq English Whisper candidate; Gemini Flash-class models for bounded text
analysis. Self-hosted ASR is optional only after cost/quality benchmarks. No GPU purchase or model training
for pilot. Voiceprint identity and employee scoring are outside the first release.

**Data and orchestration:** PostgreSQL/pgvector/FTS and a durable job/outbox mechanism. Retain existing
authentication, secret interfaces and approval gate. No raw audio in a relational database or routine logs.

**Privacy/access:** private projects, actor-authorized customer aggregation, private threads by default,
source-linked answers, temporary-media deletion and removal of derived data on deletion/correction.

## 3. What "like Fathom" means here

It means a smooth automatic meeting-to-notes experience, searchable meeting history, summaries,
action items and questions over past conversations. It does not mean copying branding or claiming
knowledge of Fathom's private code/infrastructure. Its public product currently has multiple capture
experiences, so "exactly Fathom" is not one technical transport.

Founder specialization: customer/project organization, persistent scoped chat, requirements changing
over time, open commitments, cited customer history and next-meeting agendas. These are product goals
to validate, not claims that competitors have none of them or that our unfinished product is better.

## 4. Requirements mapped to implementation and proof

| Requirement | Features | Proof |
|---|---|---|
| No recurring manual Google cookie upload | F03–F05 | Real scheduled joins using supported provider policy; no browser-cookie setup in normal user flow |
| Capture while founder absent | F04/F05 | Meeting with other participants, founder absent; admission policy documented |
| Capture until end and stop | F05/F06 | Overrun, everyone-left grace, host end, explicit stop and restart tests |
| Every meeting summary | F06/F07 | Correct timed text, cited claims, partial/no-speech distinctions |
| Summarize all previous customer meetings | F08/F09 | Multi-project customer history with authorized source coverage |
| Projects and saved chats | F02/F10 | Reload/resume thread, scoped follow-up, source access revocation |
| Agenda for next meeting | F11 | Prior commitments + upcoming objective, edit preservation, reschedule |
| Integrations | F03/F12 | Calendar sync and approved task execution with duplicate protection |
| Low operating cost | F04/F06/F13 | Actual bot runtime, ASR/model usage and five-call hardware benchmark |
| Scalable feature development | F00–F14 | Module boundaries, migration tests, independent workers and bounded concurrency |
| Do not store permanent recordings | F06/F13 | Deadline cleanup and storage/backup policy checks |
| Truthful product behavior | All | No mock success, no invented speaker confidence or capture completeness |

## 5. Known risks and mandatory responses

| Risk | Response / release condition |
|---|---|
| Host denies or restricts bots | Explain unsupported policy; never recommend making every customer meeting public as the normal setup |
| Vexa Zoom is web-client based | Qualification required; no claim of native Zoom SDK parity |
| Upstream API/version changes | Pin releases, contract fixtures and migration rehearsal |
| Tiny recognizer inaccurate | Treat bundled tiny.en as smoke-only; qualified STT required |
| Provider POST times out after creating bot | Durable unresolved state + reconciliation; no blind create retry |
| Stop endpoint targets newest native-key occurrence | Serialize by provider account/native key and check immutable record state |
| Provider key shared across workspaces | Disallow until tenant isolation is proven; distinct account scope per workspace |
| Temporary recording retained in backup/version history | Explicit storage lifecycle/backup exclusion and provider retention proof |
| Cheap host cannot run five bots | Load-test sizing; increase capacity or reduce supported concurrency explicitly |
| Whole-history summaries exceed model context | Hierarchical incremental aggregation with recoverable source references |
| Private project leaks through customer summary | Authorized source-set aggregation/cache keys and adversarial tests |
| Repeated OAuth login | Distinguish transient refresh from revoked grant; durable credential storage |
| Long-running task delays capture scheduling | Separate scheduler/capture workers from analysis queues |
| Generated code grows without clear ownership | Small vertical slices and module dependency checks; no placeholder architecture scaffolding |

## 6. Items requiring external qualification, not more code guessing

- Provider release compatibility, real host-admission policies and account-level restrictions.
- Actual five-bot server footprint and per-meeting runtime billing.
- Vexa STT bridge protocol, usable speaker timing and Groq transcription quality on pilot recordings.
- Hard-deadline media removal across provider primary storage, app caches and configured backups.
- OAuth application approvals, scopes and provider account quotas.
- Deployment region and final budget before paid resources are provisioned.

These do not prevent completing the design. They do prevent declaring the future release production
ready or deploying a paid setup without the necessary account/configuration decisions.

## 7. Document precedence and maintenance

`PROJECT_PLAN.md` is the index. Documents 18 and 20–24 define the target. Document 19 records actual
work. Documents 01–17, dev-balance and old external setup guides are legacy/historical references,
not commands to continue the previous approach. Update the progress ledger with evidence after
each implementation slice; never rewrite historical test results as current proof.
