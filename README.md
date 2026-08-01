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
