# VisualSprint continuation — 2026-10-15

Historical checkpoint. Its pending-work statements describe October 15 only; use
[the October 16 continuation](continuation-2026-10-16.md) for current implementation and gates.

## Authoritative checkout and boundaries

- Worktree: `C:/Users/thano/.codex/worktrees/visualsprint-microservices/MeetForge`.
- Branch: `codex/zedex-web-rebuild`; remote: `thanoban/visualsprint-core`.
- Preserve the original dirty legacy checkout and unrelated AI/ML study-roadmap changes.
- Use the approved v3 TypeScript microservices plan. English, text-only, managed Recall capture,
  explicit owner confirmation, separate sharing, isolated service databases and Azure remain fixed.
- Do not deploy/provision paid infrastructure or make live provider/model calls without the
  separate configuration/authority decision. An infrastructure activation flag being false does
  not make the foundation deployment free.

## Published and independently checked

| Commit    | Scope                                                                                                                              | Evidence                                                                                                                                                            |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2b2bfac` | Consent-bound reference-only processing-event contract and gateway boundaries                                                      | Six contract and three gateway checks; repository check; GitHub Actions success                                                                                     |
| `5efca62` | Native Intelligence metadata outbox publisher                                                                                      | 25 unit and 12 owning PostgreSQL checks, build/typecheck; GitHub Actions success                                                                                    |
| `e0ab669` | Account/Ingest processing consent, stable transcript revisions, bounded evidence, private Workspace context and mounted consent UI | Account 7 unit/27 database, Ingest 20 unit/22 database, Workspace 7 unit/21 database, web 7 unit/27 browser checks; real signed composition; GitHub Actions success |
| `6038e32` | Azure source modules, private role bootstrap, configuration/runbooks and credential-free CI qualification                          | Ten Bicep files compiled, 13 guard tests and isolated PostgreSQL bootstrap passed; GitHub Actions success                                                           |

Provider, model and hosted identity responses were controlled in local tests. The successful
signed composition caught and corrected an actual POST-versus-GET owner-context adapter mismatch.
Database volumes were preserved across Docker restarts. Azure was not deployed.

## Saved corrective work requiring final publication

1. **Ingest withdrawal recovery:** wake metadata routing and retain retries for active, terminal
   and future captures; cleanup must survive logout and disabling new processing. Existing-owner
   status/withdrawal endpoints stay available independently of new consent/evidence gates.
   Applied Account 0006/0007, Ingest 0009 and Intelligence 0006 SQL must not be edited.
2. **Accepted commitment to external action UI:** preserve commitment ID/version in the action
   source schema; choose current human-reviewed evidence; explicitly approve the exact payload
   and execute separately; fetch real task status without calling human completion verified.

The source drafts are not release proof. Re-run owning tests/builds, signed composition and
browser checks before staging only each completed slice. Agents own Account/Ingest, apps/web,
and read-only architecture/release audit respectively until ownership is explicitly reassigned.

## Next implementation gates

1. Connect the consent-bound processing event producer and Intelligence consumer. Recheck current
   grant/membership/deletion/source revision before evidence, paid dispatch and publication;
   use dedicated grant-scoped model admission, inbox/job deduplication and fenced one-shot I/O.
   Consent-ready currently does not imply generated summary-ready.
2. Add owner-reviewed agenda persistence/APIs. Existing Intelligence preparation stays a draft;
   do not export it as an accepted agenda or silently accept generated content.
3. Complete reviewed-record exports through a Reporting-pinned authorized Workspace snapshot.
   Existing exports cover notes/transcripts, not every accepted fact/agenda. Current public lists
   cap at 100; complete exports must fail explicitly beyond supported bounds, never truncate.
   Snapshot fingerprints must include accepted revisions/content/evidence status and agenda edits;
   reauthorize before publishing and downloading artifacts.
4. Qualify native Blob/PubSub adapters and telemetry/alert delivery before claiming those provisioned
   resources are connected to the application. Source IaC alone does not wire runtime behavior.
5. Run approved staging identity/calendar/Recall/connector/model/email tests, full-duration stop/
   denial/removal scenarios, five-concurrent load, backup restoration/tombstone replay and migration
   rollback. Live provider joining, production latency and pilot quality remain unproved.

Calendar push retirement currently relies on remote subscription expiration rather than remote
unsubscribe. Azure topology, secrets, quotas, TLS, DNS/private-link approvals and image digests
require the operator checks in `infra/azure/CONFIGURATION.md` and `RUNBOOK.md`.

## Resume verification

Start with git status/upstream and Docker health. Do not reset existing volumes. Run `pnpm check`,
affected owning integration/browser suites and `tests/system/foundation.test.ts`. Use
`BICEP_BIN` with the pinned official compiler for `node infra/azure/validate.mjs`; no Azure login
is needed. Inspect current CI rather than treating this historical checkpoint as current proof.
