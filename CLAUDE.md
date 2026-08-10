# VisualSprint — Agent Instructions

Multilingual (Sinhala/Tamil/English) meeting-intelligence platform. Full plan: [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) (split topically in `docs/01`–`07`). Read those for depth — this file states only what a fresh session must not re-derive or re-litigate.

**North star / acceptance test:** "why are we using MongoDB?" must return a traced answer across meetings — speaker, transcript span, screen evidence — correctly transcribed through code-switching, any capture gap disclosed honestly.

## Non-negotiable architecture rules

1. **Deterministic software owns the workflow.** Agents interpret content; they never call each other, choose the next pipeline stage, or self-certify their own output as correct.
2. **Report Intelligence's input schema cannot contain raw transcript.** Type-enforced (`backend/app/interfaces/`), not a prompt instruction — hallucination cannot reach the user-facing report.
3. **Verification never sees the extractor's reasoning**, only the claim + raw evidence. Self-consistency is not verification.
4. **Every external dependency goes through a swap-point interface** (`Transcriber`, `Diarizer`, `OcrEngine`, `LlmClient`, `PlatformAdapter`, `ActionConnector` in `backend/app/interfaces/`). Never call a vendor SDK directly from pipeline/agent code.
5. **`proposed_action` cannot execute without an approval record** — enforced by a DB CHECK constraint (`ck_action_requires_approval`), not app logic. Never build a path that bypasses it.
6. **Capture gaps are data, not silence.** Any coverage hole becomes a `coverage_interval` row and must visibly flag overlapping `knowledge_item`s.

## Decisions already made — do not re-open without new evidence

- **ASR: buy everything, train nothing.** Google `chirp_2` ⇄ Azure `si-LK`/`ta-IN` locked primary/fallback pair — the only two Sinhala vendors that exist (verified against vendor docs, not blogs). Groq for English. No GPU, no fine-tuning track. Rationale + numbers: [docs/04-asr.md](docs/04-asr.md).
- **Capture: official platform APIs first**, bots are fallback Mode B only. Build order is Mode D (upload) → A2 (artifacts) → A1 (Zoom RTMS). Browser screen-share is dead; don't resurrect it. [docs/03-capture.md](docs/03-capture.md).
- **No Neo4j, no separate vector DB.** Postgres + pgvector + FTS handles knowledge graph traversal at this scale.
- **No Temporal yet.** Postgres-FSM (`FOR UPDATE SKIP LOCKED`) is the orchestrator; Temporal is the documented upgrade path, not the current build.
- **Agents run on Claude via Vertex AI by default**, not the direct Anthropic API. `LlmClient` adapter targets `anthropic[vertex]` / Vertex AI's Claude endpoints; auth is GCP service-account credentials (same GCP project as the Google Speech-to-Text vendor, so one set of cloud credentials covers both). Model IDs stay the same (`claude-sonnet-5` etc.) — only the transport changes.
  - **Update 2026-08-08**: Claude went GA on Microsoft Foundry (Azure) on 2026-06-29 — a fact that didn't exist when the Vertex-only decision above was made. `app/adapters/llm_foundry.py` (`FoundryLlmClient`, via the `anthropic` SDK's built-in `AnthropicFoundry` client) is now a second `LlmClient` implementation behind the same interface, selected via `VS_LLM_PROVIDER=vertex|foundry` (`app/config.py`). Added because GCP billing was blocked on both available GCP accounts. Vertex stays the intended default once GCP billing clears — this is a documented swap for a blocker, not a reversal of the decision.
- **Reports embed screenshot evidence, not just links.** Every report claim tied to a keyframe renders the actual screen-capture thumbnail inline (not merely a clickable reference) — this is the speech↔screen grounding feature made visible, and it's a first-class part of `ReportInput`, not an optional enhancement.
- If a new fact contradicts one of these (e.g. a vendor adds Sinhala code-switching), say so explicitly and cite the source — don't silently drift back to an old assumption either.

## Conventions

- **Git: commit and push as the user, never add a Claude/AI co-author trailer or "Generated with Claude Code" footer.** No exceptions.
- New DB tables/columns → SQLAlchemy model in `backend/app/db/models.py` + Alembic migration; never hand-write SQL migrations.
- New vendor integration → implement the relevant `Protocol` in `backend/app/interfaces/`, concrete class in `backend/app/adapters/`, never leak vendor types past that boundary.
- Pipeline stages are idempotent jobs (`backend/app/orchestrator/pipeline.py` defines stage order) — a handler must be safe to re-run after a crash.
- Windows dev machine: PowerShell is primary, Bash tool also available; Docker Desktop sometimes needs a manual launch before `docker compose` works.

## Current state

Phase 0 done and **runtime-verified end-to-end**: schema (incl. `audio_track`), six interfaces, FSM orchestrator, blob store, Mode D upload → `acquire` → `transcribe` stage handlers, first Alembic migration applied against the docker-compose Postgres. `tests/test_upload_pipeline.py` proves upload→utterance rows with a fake Transcriber (no live vendor credentials needed to run it).

The full ASR cascade (`backend/app/asr/` — Silero VAD → VoxLingua107 LID → Google/Azure/Groq routing with auto-failover, `backend/app/adapters/asr_*.py`) and all five agents (`backend/app/agents/`) plus action connectors (`backend/app/connectors/`) are implemented but not yet wired into a live end-to-end run — they need real vendor/Vertex credentials, which aren't configured in dev yet. `understand`/`verify`/`remember`/`propose`/`report` stage handlers exist in `worker.py` and call into the agents, but haven't been runtime-verified past `transcribe`.

Check `docs/06-roadmap.md` for phase status before assuming something is built.
