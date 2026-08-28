# VisualSprint

Core platform for multilingual meeting intelligence, transforming Sinhala, Tamil, and English conversations, shared screens, and meeting history into searchable knowledge, organizational memory, and actions.

**Product loop:** Capture → Understand → Verify → Remember → Act

📄 Full architecture and roadmap: [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) (or browse the split docs starting at [docs/README.md](docs/README.md))

## Monorepo layout

```
backend/    Python 3.12 · FastAPI · SQLAlchemy · Postgres-FSM orchestrator · agents
frontend/   Next.js + TypeScript (report, chat, corrections, approvals) — Phase 5
infra/      docker-compose (Postgres 16 + pgvector), deploy assets
docs/       PROJECT_PLAN.md — the approved full plan (single source of truth)
```

## Core principles (non-negotiable)

1. **Deterministic software owns the workflow** — agents interpret content, never orchestrate.
2. **Report agent can never see raw transcript** — enforced by input schema, not prompts.
3. **Every external dependency sits behind a swap interface** — buy now, own later at zero refactor cost.
4. **Nothing fails silently** — capture gaps are first-class data, disclosed to the user.
5. **Actions are always human-gated** — `proposed_action` cannot execute without an approval record (DB-enforced).

## How to use (live product)

The deployed app is at **https://visualsprint-web-5ieahiycsa-uw.a.run.app**.

1. **Sign up / log in** — email + password via Supabase Auth. First login auto-creates
   your personal org.
2. **Get a meeting captured**, any one of:
   - **Upload** (`/upload`) — drag in an existing recording (`.mp3`/`.wav`/`.webm`).
     Works fully today, no setup required.
   - **Companion Chrome extension** (`extension/`) — load unpacked in
     `chrome://extensions` (Developer mode → "Load unpacked"), join a Google Meet call,
     click the extension icon to start recording your own tab; it uploads chunks live
     and finalizes when the call ends.
   - **Connect Zoom/Google/Microsoft calendar** (`/settings/connections`) — VisualSprint
     auto-joins scheduled meetings as a bot, or (Zoom only) streams live via RTMS.
3. **Wait for the pipeline** — a new meeting runs through capture → diarize → identify
   speakers → transcribe → OCR screen content → extract knowledge → verify → remember
   → propose actions → report. Takes a few minutes per meeting.
4. **Open the report** (`/meetings`) — see decisions, commitments, and blockers, each
   with the exact transcript quote and — where available — the screenshot it came from.
   Approve or reject any proposed follow-up action before it's sent anywhere.
5. **Browse `/people`** — per-person history across all their meetings: what they
   committed to, whether it was resolved, and patterns over time.

Full local-dev setup (running the whole stack, including RTMS and the bot, on your
own machine): [docs/15-local-dev.md](docs/15-local-dev.md).

## Quick start (dev)

```bash
# 1. Start Postgres 16 + pgvector
docker compose -f infra/docker-compose.yml up -d

# 2. Backend
cd backend
python -m venv .venv && .venv/Scripts/activate   # Windows
pip install -e ".[dev]"
alembic upgrade head
uvicorn app.main:app --reload

# 3. Walking skeleton: upload a recording
curl -F "file=@meeting.mp3" http://localhost:8000/api/v1/meetings/upload
```
