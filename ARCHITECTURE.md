# ARCHITECTURE — as-built review

**Scope.** [docs/02-architecture.md](docs/02-architecture.md) states the *intended* architecture — the spine, the five agents, the anti-hallucination rules. This file documents the system **as it actually exists in code**, and records an architecture review of it: what holds up, what does not, and what to change.

**Review date:** 2026-08-18 · **Method:** static reading of `backend/app/**`, `backend/alembic/**`, `backend/tests/**`, `.github/workflows/**`, `infra/docker-compose.yml`.

**Status: all findings below are fixed.** Remediation was verified against a live Postgres 16 + pgvector instance with migrations applied — not statically. Verification state at the end of the pass:

| Check | Result |
|---|---|
| `ruff check app tests` | clean (9 pre-existing violations fixed — CI would have failed on these too) |
| `pytest tests` | **587 passed, 1 skipped, 0 failed** (was 529 passed / 13 failed) |
| `pytest tests` with `VS_TEST_DATABASE_URL` | 587 passed — the same suite, now also green against real Postgres |
| `scripts/mypy_gate.py` | passes: rule-enforcement modules clean under `strict`, whole-app ratchet at 369 (was 397) |
| Migrations | `upgrade head` → `downgrade -2` → `upgrade head` verified |
| Agent-eval regression gate | passes |

Each finding keeps its original diagnosis and gains a **Fixed** block naming the change and the test that pins it.

---

## 1. Verdict

The architecture is sound and the non-negotiables in [CLAUDE.md](CLAUDE.md) are genuinely enforced in code rather than in prose:

| Rule | Enforcement found |
|---|---|
| 1 — deterministic software owns the workflow | `app/orchestrator/pipeline.py` `STAGES` dict; agents are called *by* stage handlers and never call each other |
| 2 — Report input cannot contain raw transcript | `app/agents/report.py` `ReportInput` schema; the human-facing `GET /report` read path is separate and downstream of verification |
| 3 — verification never sees extractor reasoning | `app/agents/context.py` deliberately does **not** persist `candidate.rationale` to any column the verify query path reads |
| 4 — every vendor behind a swap-point interface | 13 Protocols in `app/interfaces/`, concrete classes in `app/adapters/`; no vendor type leaks past that boundary |
| 5 — no action without approval | `ck_action_requires_approval` CHECK constraint on `proposed_action` |
| 6 — capture gaps are data | `coverage_interval` is a first-class table, written from *raw* ASR segments before LLM repair |

The data model is evidence-first and correctly org-scoped (`org_id` on every table, `knowledge_evidence` XOR check, `ck_edge_no_self`). Postgres-as-queue over Temporal/Celery is the right call at this scale.

**The problems were concentrated in the execution layer** — runtime correctness, tenant isolation on read paths, and CI — not in the design. Nothing in the remediation required changing the architecture; F9 in particular was implemented as a decorator on an existing swap point rather than as a cross-cutting edit, which is that rule paying for itself again.

---

## 2. As-built component map

```
frontend/ (Next.js 15, app router)
    └── Supabase Auth (ES256 JWT) ──┐
                                    ▼
backend/app/main.py  (FastAPI, CORS, 11 routers)
    ├── api/upload.py        Mode D upload → blob → enqueue_pipeline
    ├── api/rtms_webhook.py  Mode A1 Zoom RTMS (signature-verified)
    ├── api/capture.py       instant capture
    ├── api/report.py        evidence-grounded report read (no LLM on this path)
    ├── api/chat.py          org-memory chat (pgvector + FTS hybrid)
    ├── api/corrections.py   utterances, speakers, glossary
    ├── api/actions.py       approve/reject → audit log
    ├── api/people.py        participant + longitudinal intelligence
    ├── api/data_rights.py   export / erasure / retention settings
    ├── api/oauth.py         per-org vendor grants → SecretStore
    └── api/me.py            user + org bootstrap

backend/app/orchestrator/    ← deterministic FSM, owns the workflow
    ├── pipeline.py   STAGES: acquire → diarize → identify → transcribe → screen
    │                         → understand → verify → remember → propose → report
    ├── queue.py      FOR UPDATE SKIP LOCKED claim, backoff retry, stuck-job reaper
    ├── worker.py     1338 LOC: stage handlers + 8 periodic sweeps
    └── scheduler.py / retention.py / erasure.py / action_triggers.py / work_tracking.py

backend/app/asr/        Silero VAD → VoxLingua107 LID → Google/Azure/Groq cascade → LLM repair
backend/app/screen/     keyframe detect → OCR → VLM caption → speech↔screen grounding
backend/app/speakers/   diarization cluster ⊕ voiceprint ⊕ platform label → identity fusion
backend/app/agents/     context · verification · memory · action · report (+ longitudinal)
backend/app/connectors/ task_create · email_draft · channel_recap · reminder · escalation
```

**Runtime topology (production, Cloud Run):**

| Service | Mode | Notes |
|---|---|---|
| `visualsprint-api` | always-warm HTTP | stateless *except* Mode A1 (see F3) |
| `visualsprint-agents` | scale-to-zero, `POST /run` | Cloud Scheduler triggers `run_bounded_pass()`; drains queue + due sweeps, then returns |
| `visualsprint-bot` | Cloud Run **Job** | one execution per `BotSession` (Mode B), currently `bot_dispatch_enabled=false` |
| `visualsprint-web` | Next.js | |

Sweep due-times are persisted in `worker_sweep_state`, not in memory — correct for a process that does not survive between invocations.

---

## 3. Findings

Severity is operational impact on the deployed system, not code aesthetics.

### CRITICAL

---

#### F1 — Retry counter is destroyed by rollback: infinite retry loop, unbounded vendor spend

**Where:** `backend/app/orchestrator/worker.py:1152` (`run_once`) × `backend/app/orchestrator/queue.py:46,85`

`claim_next_job` increments `attempts` and `flush()`es — it never commits. When a handler raises:

```python
db.rollback()                          # attempts 1 → 0, RUNNING → QUEUED, all reverted
with Session() as db2:
    job2 = db2.get(PipelineJob, job.id)    # reads attempts == 0
    q.fail_job(db2, job2, ...)             # `attempts >= max_attempts` is never true
```

Consequences:

- `attempts` is permanently **0**. `JobStatus.FAILED` is unreachable.
- `CaptureState.FAILED` is unreachable — a session that can never succeed reports as still processing, forever.
- Backoff is permanently `min(300, 5 * 2**0)` = **5 seconds**, not exponential.
- A deterministically-failing stage (revoked OAuth token, corrupt audio, Vertex quota exhaustion) calls the paid vendor **every 5 seconds indefinitely**.

Same root cause covers hard crashes: an OOM from torch/paddleocr/pyannote rolls back the claim wholesale, so `reap_stuck_jobs` never observes a `RUNNING` row and `attempts` still never rises — a poison-pill job loops forever.

**Why the tests miss it:** `tests/orchestrator/test_queue.py` calls `fail_job` in the *same* session that performed the claim, where the increment is still live. No test exercises `run_once`'s failure path at all.

**Fix:** claim in its own transaction and commit before invoking the handler — `claim → commit → run → complete/fail`. This also makes `reap_stuck_jobs` meaningful for the first time (today it can only ever fire for a job whose worker is still holding the row lock, which it skips by design).

**Fixed.** `run_once` now claims and **commits** in its own transaction before dispatching the handler (`app/orchestrator/worker.py`), so `attempts` is durable. Retry limits, exponential backoff and `reap_stuck_jobs` all work for the first time; a hard crash now leaves a durable RUNNING row for the reaper instead of vanishing. `queue.py`'s module docstring states the invariant so the two are not collapsed back together. Pinned by `tests/orchestrator/test_worker_failure_path.py` (4 tests) — verified to **fail against the pre-fix code** and pass against the fix.

---

#### F2 — Three unauthenticated endpoints leak cross-tenant meeting content

Each requires only a UUID: no `get_current_user`, no `is_org_member`, no `require_org_member`.

| Route | File | Leaks |
|---|---|---|
| `GET /api/v1/meetings/{capture_session_id}/report` | `app/api/report.py:194` | every knowledge item, evidence quote, speaker attribution, keyframe URL |
| `GET /api/v1/meetings/{capture_session_id}/utterances` | `app/api/corrections.py:56` | the entire raw transcript |
| `GET /api/v1/meetings/sessions/{session_id}` | `app/api/upload.py:116` | session state, mode, error text |

The neighbouring `list_meeting_speakers` (`app/api/corrections.py:126`) performs the check correctly, which is what marks these as an omission rather than a design choice.

**Fix:** a shared `require_session_member(capture_session_id)` FastAPI dependency that resolves the session, 404s if absent, and 403s on non-membership — a single enforcement point, so this cannot be forgotten a fourth time. Retrofit the three routes onto it.

**Fixed.** `require_session_member` (`app/auth/dependency.py`) resolves the session, 404s if absent, 403s on non-membership, and returns the row so a handler cannot re-fetch it unchecked. All three routes now depend on it. Pinned by `tests/api/test_session_authorization.py`, which includes a **structural guard**: it walks `app.routes` and fails if any route taking a `{capture_session_id}` lacks the dependency, so a fourth route cannot repeat the omission silently.

---

#### F3 — Mode A1 (Zoom RTMS) holds live-meeting state in API process memory

**Where:** `backend/app/api/rtms_webhook.py:56` (`_active_streams`), `:197` (task stored), `:203–207` (`await task`, then `result.pcm_bytes`)

`_active_streams` is a module-level dict, and the entire meeting's audio accumulates in RAM as `result.pcm_bytes` until the `rtms_stopped` webhook arrives.

- **Multi-instance:** `rtms_started` and `rtms_stopped` can land on different Cloud Run containers → `404 no active RTMS stream`, capture silently lost.
- **Memory:** one hour of 16 kHz 16-bit mono PCM ≈ 115 MB; per-participant tracks multiply it. This sits in the API container alongside request handling.
- **Leak:** if `rtms_stopped` never arrives (crash, network partition, Zoom retry exhaustion), the asyncio task and its buffer are never reclaimed.
- **Rule 6 violation in spirit:** a lost stream produces no `coverage_interval` row. The gap becomes silence, which is exactly what rule 6 forbids.
- `await task` inside the `rtms_stopped` HTTP handler can block the request for the remaining duration of the stream teardown.

**Fix:** stream to blob storage incrementally instead of accumulating bytes; make the `CaptureSession`/`BotSession` row the state rather than a process-local dict; host RTMS on the always-on host already scoped for Mode B, not the API service. **Minimum viable now:** a watchdog sweep that finalizes orphaned streams and writes the coverage gap.

**Fixed** (within what is possible while RTMS still runs on the API service).
- **Memory no longer scales with meeting length.** `_Buffer` (`app/capture/rtms_client.py`) spools to disk past 8 MiB instead of accumulating a `list[bytes]` and joining it — that join alone peaked at ~2x the recording.
- **The stream is findable from the database.** New `capture_session.rtms_stream_id` column + index, set at `rtms_started`.
- **A stop event on the wrong instance no longer loses the capture silently.** It resolves the session from the DB and calls `mark_stream_lost`, writing a `coverage_interval` and failing the session — rule 6 applied to the largest gap there is. Previously a bare 404 that left the session running forever with no record.
- **A stop event that never arrives is swept up.** New `rtms_watchdog` sweep (`app/capture/rtms_recovery.py`) discloses A1 sessions still live past any plausible meeting length.

Pinned by `tests/capture/test_rtms_recovery.py` (6 tests) and 3 new webhook/buffer tests. **Residual:** the audio still lives in one container's memory for the meeting's duration, so a recycled container still loses that recording — it is now disclosed rather than silent. Moving RTMS onto the always-on host Mode B needs remains the real fix.

---

#### F4 — Unmapped Zoom accounts fall into a shared "default" org

**Where:** `backend/app/api/rtms_webhook.py:69` (`_get_org_by_default`), called as the fallback at `:103`

When an incoming `account_id` matches no `OrgConnection`, the handler creates/returns an org literally named `"default"` and files the meeting there. Every unmapped Zoom account that has authorized the app therefore writes its meeting content into **one org shared between unrelated tenants**.

**Fix:** reject the webhook (404 + structured log) when the account cannot be resolved to a real org. There is no correct default tenant.

**Fixed.** `_get_org_by_default` is deleted. An unresolvable `account_id` now raises 404 with a message pointing at the org's Zoom connection settings. Pinned by 3 tests in `tests/api/test_rtms_webhook.py`, including a regression guard asserting **no Org named "default" is ever created**. Two end-to-end webhook tests were updated to connect a real Zoom account first, via a new `connected_zoom_org` fixture.

---

### HIGH

---

#### F5 — A stage handler holds an open transaction and a row lock for its entire runtime

**Where:** `backend/app/orchestrator/worker.py:1152–1172`; worst case `_handle_transcribe` at `:835`

`run_once` claims inside the session and does not commit until the handler returns. `_handle_transcribe` runs full vendor ASR **plus one LLM repair call per segment** inside that transaction. For an hour-long recording that is a Postgres transaction held open for tens of minutes.

- idle-in-transaction connections consumed for the duration
- autovacuum blocked on `utterance`, `coverage_interval`, `pipeline_job`
- any connection blip discards the entire stage's work

Note the current design *does* get one thing right as a side effect: because the row lock is held, `reap_stuck_jobs`'s `skip_locked` correctly skips genuinely-live jobs. Preserve that property when fixing F1 — reap on `locked_at` age with `skip_locked`, which still works once the claim is committed separately.

**Fix:** restructure with F1 — claim/commit, run the work outside any transaction, then open a short transaction to write results and complete the job. Handlers already delete-then-insert (documented as idempotent in `_handle_transcribe`'s docstring), so this is safe.

**Fixed for the stages that caused it.** The job row lock is released at claim time (see F1), so `pipeline_job` is no longer locked for hours. Both multi-minute stages were restructured into **read → work → write** phases around a new `_release_transaction` helper: `_handle_transcribe` and `_handle_screen` now run vendor ASR, LLM repair, OCR and VLM captioning with **no transaction held**, then write in one short transaction.

A second benefit fell out: both now delete the previous attempt's rows immediately before re-inserting rather than up front, so a stage that dies mid-work leaves the prior attempt's transcript/keyframes intact instead of blanking them.

**Residual, stated plainly:** the agent stages (`understand`/`verify`/`remember`/`propose`/`report`) still hold a session across their LLM calls. That is a single call of seconds-to-a-minute, not the hour-scale case this finding was about, and splitting them would mean restructuring all five agents' internals. Left deliberately.

---

#### F6 — CI never runs on the path that deploys

**Where:** `.github/workflows/quality.yml` (`on: pull_request`) vs `.github/workflows/deploy.yml` (`on: push: branches: [main]`)

The quality gate — ruff, pytest, and the frozen agent-evaluation regression gate — triggers only on pull requests. Deploy triggers on push to main. Recent history is direct commits to main, so **lint, tests, and the agent-eval gate ran for none of those deploys**.

**Fix:** add `push: { branches: [main] }` to `quality.yml`, and make the deploy job `needs:` it so a red build cannot ship.

**Fixed.** `quality.yml` now triggers on `pull_request`, `push: [main]`, `workflow_call` and `workflow_dispatch`. `deploy.yml` gained a `quality` job that **invokes quality.yml as a reusable workflow**, with `build-and-deploy` set to `needs: quality` — so the gate that runs on a PR and the gate that guards a deploy are literally the same file and cannot drift apart. A red build can no longer ship.

---

#### F7 — The backend CI job would fail if it ever did run

**Where:** `.github/workflows/quality.yml` backend job vs `backend/tests/test_upload_pipeline.py`

`test_upload_pipeline.py` — the walking-skeleton test, the one that proves the whole spine — requires a live Postgres at `localhost:5433` (it drives `worker.run_once()` against `get_sessionmaker()`). It is **not** in the `--deselect` list, and the workflow provisions no `services:` block. The job would error at fixture setup.

**Fix:** add a `pgvector/pgvector:pg16` service container plus `alembic upgrade head` to the backend job. That also lets you drop the `--deselect tests/test_vector_search_postgres.py` and finally exercise the pgvector path in CI.

**Fixed.** The backend job gained a `pgvector/pgvector:pg16` service container, `alembic upgrade head`, and a `[test]` extra in `pyproject.toml`.

The extra turned out to be load-bearing beyond the Postgres issue: CI installed only `[dev]`, but several test modules import their adapter at module scope, so the suite **died at collection** with `ModuleNotFoundError` on `anthropic`, `azure`, `cv2` and `numpy` — the job could never have gone green regardless. `[test]` pins exactly what collection needs and deliberately excludes the heavy extras (torch, speechbrain, paddleocr, pyannote, playwright), which nothing in the suite requires.

Two further blockers found while making it actually pass:
- `_handle_transcribe` called `_get_llm()` eagerly for the *optional* repair pass, so with no GCP credentials it raised `DefaultCredentialsError` and destroyed a perfectly good transcript — defeating the graceful degradation `app/asr/repair.py` was explicitly written for, and guaranteeing the walking-skeleton test could never pass in CI. Now `_get_optional_llm()`, following the existing `_get_embedder` convention.
- Six capture tests asserted the untranscoded fallback by relying on ffmpeg being **absent from the machine** (one docstring said so outright), so they failed on any dev box that had it. `tests/capture/conftest.py` now pins availability off, making the fallback the deliberate subject of those tests.

---

#### F8 — `mypy strict` is configured and never invoked

**Where:** `backend/pyproject.toml` `[tool.mypy] strict = true`; absent from `quality.yml`

Rule 2's guarantee is explicitly a *type* guarantee ("`ReportInput` structurally cannot hold transcript"). An unrun type checker means the enforcement mechanism for the project's headline safety property is itself unverified.

**Fix:** `python -m mypy app` in the backend CI job. Expect an initial backlog; gate on "no new errors" if a clean run is far off.

**Fixed, two-tier.** `backend/scripts/mypy_gate.py` runs in CI:
- **Strict-zero** on `app/interfaces`, `app/agents`, `app/db`, `app/auth` — the modules the non-negotiable rules actually live in. The 20 errors there were fixed, so a type error in the rule-enforcement surface now fails the build outright.
- **Ratchet** everywhere else: the whole-app count is pinned and CI fails if it rises. New code cannot add type errors and the backlog can only be paid down; when it drops the script says so, so the ratchet tightens rather than drifting.

The baseline went 397 → 369 during this pass. The ratchet proved itself immediately by catching 3 type errors in my own F3 code, which were fixed rather than absorbed.

---

#### F9 — No LLM cost accounting

**Where:** `app/interfaces/llm.py` `LlmUsage`; consumed at `app/agents/context.py:244`, `app/agents/action.py:93`, and equivalents

`LlmUsage` is threaded correctly through every agent and then handed only to `log.info(...)`. No table records tokens, model, stage, or org, so nothing can attribute spend, cap it, or alarm on it.

On a single student GCP trial credit, combined with F1's infinite retry and a repair call on *every* ASR segment (`model_repair`, described in config as "cheap, high-volume"), this is the failure mode most likely to actually cause damage.

**Fix:** an `llm_call` table (`org_id`, `capture_session_id`, `stage`, `model`, `input_tokens`, `output_tokens`, `latency_ms`) written in the same commit as the stage output, plus a per-org monthly budget check the worker consults before dispatching a paid stage.

**Fixed.** New `llm_call` table (org, capture session, stage, model, in/out tokens, latency, ok, error) plus `Org.monthly_llm_token_budget`, both in one migration.

Implemented as `RecordingLlmClient` — a decorator implementing the `LlmClient` Protocol — so **no agent was touched**; call-site context travels by contextvar. Rows are written in their **own committed transaction**, so spend survives the stage that incurred it rolling back; under-reporting exactly while a job retries would hide the most expensive failure mode there is. Failed calls are recorded too, since a call that errors after generation still costs money.

`check_org_budget` runs before any LLM-bearing stage; `LlmBudgetExceeded` is treated as **terminal, not retryable** (`_record_failure` exhausts attempts immediately) — retrying a budget refusal is how an overspend becomes a runaway. `GET /orgs/{org_id}/llm-spend` exposes month-to-date totals by stage and model. Pinned by `tests/orchestrator/test_llm_accounting.py` (7 tests).

---

### MEDIUM

---

#### F10 — Global FIFO claim: no tenant fairness

`claim_next_job` (`app/orchestrator/queue.py:46`) orders by `run_at` across all orgs, and the worker processes one job at a time serially. One org uploading 200 recordings starves every other org for hours.

**Fix (cheapest first):** a per-org in-flight cap in the claim predicate → a `priority` column → partitioned claims. Worth doing before the second real customer, not after.

**Fixed.** `claim_next_job` now excludes orgs already at `worker_max_inflight_per_org` (default 2) RUNNING jobs. Jobs are *skipped*, never reordered, so per-org FIFO is preserved. Pinned by `tests/orchestrator/test_queue_fairness.py`, including a guard that a single tenant alone still drains (the cap must not deadlock the common case).

---

#### F11 — No ANN index on either vector column

`KnowledgeItem.embedding` (1024-d, `models.py:561`), `SessionSpeaker.embedding` and `Person.voiceprint` (512-d) have no `hnsw`/`ivfflat` index in any migration. Every `cosine_distance` ordering — `app/api/chat.py:127`, `app/agents/memory.py:118` — is a sequential scan over the org's rows.

Acceptable at current scale. **Fix before the knowledge base grows:** a migration adding `USING hnsw (embedding vector_cosine_ops)`.

**Fixed.** HNSW indexes on `knowledge_item.embedding`, `person.voiceprint` and `session_speaker.embedding`, using `vector_cosine_ops` to match the `cosine_distance` ordering the queries actually use. Declared in the models with `.ddl_if(dialect="postgresql")` so the SQLite test metadata stays creatable and Alembic autogenerate does not drift. Migration verified up/down/up against real pgvector.

---

#### F12 — Tests run on SQLite, production runs on Postgres + pgvector

`tests/api/conftest.py` builds an in-memory SQLite DB. Consequences, honestly documented in the test files themselves but worth stating as an architectural gap:

- pgvector paths are skipped, not tested
- `FOR UPDATE SKIP LOCKED` is a no-op, so concurrent-worker locking is unproven
- CHECK constraints — including `ck_action_requires_approval`, rule 5's entire enforcement — are not exercised as they are in production

**Fix:** once F7's Postgres service exists, point the API fixture at it (transaction-per-test rollback keeps it fast).

**Fixed.** `tests/api/conftest.py` uses Postgres when `VS_TEST_DATABASE_URL` is set (CI sets it) and SQLite otherwise, so a plain `pytest` still works with no services running. Postgres mode wraps each test in a transaction rolled back at the end, with `join_transaction_mode="create_savepoint"` so tests that commit stay isolated. The full suite passes in **both** modes.

**This fix paid for itself twice within minutes of existing**, which is the argument for it:
1. It caught a dangling FK in a fixture I had just written (`org_member.user_id` with no `app_user` row) — silently accepted by SQLite.
2. It exposed **F17** below.

---

#### F13 — `WORKER_ID` is not unique

`app/orchestrator/queue.py:17`:

```python
WORKER_ID = f"{socket.gethostname()}:{id(object())}"
```

`id()` of an immediately-garbage temporary object is a reused memory address, not an identity. Two worker processes on one host can collide. Diagnostic-only today — locking is DB-side — but `locked_by` is exactly the field read during an incident.

**Fix:** `uuid4()`, or `os.getpid()` combined with the hostname.

**Fixed.** `WORKER_ID` is now `hostname[:24]:pid:uuid4[:8]`. The first attempt used a full uuid4 and **overflowed `locked_by`'s `String(64)`** — caught immediately by the Postgres-backed tests, and exactly the class of thing SQLite would have accepted silently. Another small argument for F12.

---

#### F14 — No dead-letter queue or failure surface

`JobStatus.FAILED` is written in exactly one place (`queue.py:88`) and read nowhere. There is no endpoint listing failed sessions, no alert, no requeue path. A customer's meeting can fail permanently with the only trace being a structlog line. (Note this is currently unreachable anyway — see F1.)

**Fix:** an ops endpoint listing `FAILED` jobs/sessions per org, and a manual requeue. Surface `CaptureState.FAILED` in the frontend rather than leaving the meeting spinning.

**Fixed.** New `app/api/ops.py`: `GET /orgs/{org_id}/failed-jobs` lists exhausted jobs with their meeting title, stage, attempts and error; `POST /orgs/{org_id}/failed-jobs/{job_id}/requeue` puts one back, resetting `attempts` (an operator requeues because the cause is fixed) and clearing the session's FAILED state so the UI stops showing a dead meeting. The requeue lookup is **scoped by org_id**, not just membership-checked, so a member of org B cannot requeue org A's job by guessing an id. Requeues are written to the audit log. Pinned by `tests/api/test_ops.py` (7 tests).

---

#### F15 — No request-scoped correlation ID

structlog is used consistently and well, but nothing binds a request/session/job id across API → queue → worker → agent. Tracing one meeting's failure means grepping by timestamp.

**Fix:** bind `capture_session_id` and a request id into structlog contextvars at the API and worker entry points.

**Fixed.** New `app/observability.py`: `configure_logging()` installs `merge_contextvars` explicitly, and `RequestContextMiddleware` binds a request id — honouring an inbound `X-Request-ID` and echoing it on the response, so a user reporting a problem can quote one id. `run_once` binds `job_id`, `stage`, `capture_session_id` and `org_id` for the life of a job. Confirmed working in captured test output: `stage.failed capture_session_id=… job_id=… org_id=… stage=acquire`.

---

#### F16 — Upload buffers the whole file in memory before the size check

`app/api/upload.py:60`:

```python
data = await file.read()          # entire body in RAM
if len(data) > MAX_UPLOAD_BYTES:  # 2 GiB — checked after the fact
```

A 2 GiB upload is 2 GiB of API-container RAM. There is also no rate limiting anywhere in the app, including on the unauthenticated Zoom webhook.

**Fix:** stream to the blob store in chunks, enforcing the byte limit as you go; add a rate limiter on the upload and webhook routes.

**Fixed.** The endpoint no longer calls `await file.read()` at all. Starlette has already spooled the body to disk by the time the handler runs, so `_upload_size()` measures the handle and `file.file` is handed straight to the blob store — the bytes never pass through the process's memory.

That required a real `put_stream` on the `BlobStore` Protocol: local writes chunks via `shutil.copyfileobj`, GCS uses `upload_from_file` (genuinely streaming). The S3/R2 adapter **buffers, and its docstring says so** — a true streaming PUT there means hand-rolling multipart SigV4 signing, and the interface asks implementations to state this rather than imply a guarantee they do not provide. GCS is the recommended production backend.

Rate limiting: `RateLimitMiddleware` applies a per-IP sliding window to the upload and Zoom-webhook routes only. It is **per instance, and documented as such** — a blunt guard against one client hammering one container, not a distributed quota. Pinned by `tests/api/test_upload_limits.py` (7 tests), including a guard that the endpoint must call `put_stream` and never `put`.

---

### DISCOVERED DURING REMEDIATION

---

#### F17 — Postgres full-text search ANDs every term, so the north-star query matched nothing

**Where:** `backend/app/api/chat.py` `_fts_candidates`

Found by the F12 fix within minutes of the API suite first running against Postgres, and invisible for as long as it ran on SQLite.

`plainto_tsquery` joins every lexeme with `&`. CLAUDE.md's stated acceptance test — *"why are we using MongoDB?"* — therefore compiled to `'use' & 'mongodb'`, requiring a knowledge item to contain **both** the stem "use" and "mongodb". Verified live against the seeded corpus:

```
query   : 'use' & 'mongodb'
match   : False | Migrate the primary datastore from MongoDB to Postgres with pgvector.
match   : False | Earlier plan: keep MongoDB and add a search index.
```

Zero results. The product's own north-star query returned nothing on the production retrieval path.

It passed in tests only because the SQLite branch below it is an OR of `ILIKE` terms — so the two dialects silently disagreed about the single most important query in the product, and the loose one was the only one anyone ever ran.

**Fixed.** The conjunction is rewritten to a disjunction (`replace(plainto_tsquery(...)::text, '&', '|')::tsquery`), matching any term and leaving `ts_rank` to discriminate — which is what ranking is for, and what the SQLite fallback was already doing. Verified live: both MongoDB items now match and rank above an unrelated item, which still correctly does not match. `tests/api/test_chat.py` passes in both dialects.

**Worth noting:** this is the kind of defect an architecture review cannot find by reading. It surfaced because a fix removed the thing that was hiding it.


---

## 4. Remediation summary

All 17 findings are fixed. Ordered as they were actually done — the two live data-exposure issues and the budget-burning retry loop first, then the gate that keeps them fixed.

| # | Finding | Outcome |
|---|---|---|
| F1 | Retry counter destroyed by rollback | Fixed — claim committed separately; 4 regression tests verified to fail pre-fix |
| F2 | Unauthenticated session reads | Fixed — shared dependency + structural route guard |
| F4 | Default-org fallback | Fixed — rejects; guard that no "default" org can be created |
| F6 | CI not on the deploy path | Fixed — quality.yml reused by deploy.yml via `needs:` |
| F7 | CI job could not pass | Fixed — Postgres service, `[test]` extra, 2 further blockers found and fixed |
| F8 | mypy never run | Fixed — strict-zero on rule modules, ratchet 397 → 369 elsewhere |
| F5 | Hour-long transactions | Fixed for transcribe/screen; agent-stage residual stated |
| F3 | RTMS in-memory state | Fixed — spooled buffer, durable stream id, disclosure + watchdog; residual stated |
| F9 | No cost accounting | Fixed — `llm_call` ledger + budget, as a decorator on the swap point |
| F10 | No tenant fairness | Fixed — per-org in-flight cap |
| F11 | No ANN index | Fixed — HNSW on all three vector columns |
| F12 | SQLite vs Postgres drift | Fixed — dual-mode conftest; **found F13's overflow and F17** |
| F13 | `WORKER_ID` not unique | Fixed — pid + random suffix, inside `String(64)` |
| F14 | No DLQ or failure surface | Fixed — ops endpoints, org-scoped requeue, audited |
| F15 | No correlation ID | Fixed — request id middleware + worker job context |
| F16 | Upload buffered in memory | Fixed — `put_stream` on the interface; rate limiting added |
| F17 | FTS ANDs every term | Fixed — disjunctive tsquery; the north-star query works |

### Residuals, stated deliberately

Two things are deliberately not fully closed, and neither is hidden:

1. **Agent stages still hold a DB session across their LLM call** (F5). One call of seconds, not the hour-scale case; closing it means restructuring five agents' internals.
2. **RTMS audio still lives in one container's memory for the meeting** (F3). Now bounded, durable-in-registry, and disclosed as a coverage gap when lost — but a recycled container still loses that recording. The real fix is moving Mode A1 onto the always-on host Mode B already needs.

### Follow-ups worth scheduling

- Burn down the 369-error mypy backlog; the ratchet makes it monotonic.
- The S3/R2 `put_stream` buffering fallback (F16) — needs multipart SigV4.
- Rate limiting is per-instance (F16); a real quota needs shared state.

## 5. What to protect

Changes in this area should be justified against these, not made incidentally:

- **The interface/adapter discipline.** 13 Protocols with adapters that do not leak vendor types is the reason the Claude → Gemini provider switch was a config change rather than a refactor. That is the rule paying for itself.
- **The evidence-first schema.** `coverage_interval`, `knowledge_evidence`'s XOR check, `ck_edge_no_self`, `org_id` on every table.
- **DB-level enforcement of rule 5.** Keep it a constraint. Never route around it in app logic.
- **Deriving the next stage from the `STAGES` graph** rather than hardcoding stage names — the comment at `rtms_webhook.py:250` records a real bug caused by a hardcoded `"transcribe"` that was never updated when `diarize` was inserted. That instinct is correct; keep applying it.
- **Postgres-as-queue** over Temporal/Celery at this scale.
- **Comment quality.** Recording *why*, including verified dead ends and empirical findings (the Vertex partner-quota 429, pyannote's undeclared `omegaconf` dependency, `AuditLog` detail leaking un-erasable content), is unusually good and is a real asset as the codebase grows.
