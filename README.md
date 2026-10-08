# VisualSprint

**Current direction (2026-10-07):** [Founder platform architecture and full delivery plan](docs/18-founder-platform-architecture.md).
**Implementation resumed on 2026-10-07.** Build one reviewed feature slice at a time, starting at
[the master plan index](docs/PROJECT_PLAN.md), then see [actual progress](docs/19-founder-platform-progress.md)
for local work versus planned features. The older capture paths below
describe the legacy product and are not evidence that the replacement is deployed.

Current development targets English-first founder workspaces: customer/project meeting history,
durable capture, cited memory, saved conversations and approved actions. The earlier multilingual
and screen-capture implementation remains legacy reference, not current release qualification.
See [the latest delivery record and worker startup](docs/27-calendar-chat-and-data-rights-delivery.md)
for working local paths and the remaining live-provider gates.
For calls absent from calendars, see [Capture now delivery and setup](docs/28-ad-hoc-capture-delivery.md).

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

## How to use (current feature-branch implementation)

The historical deployment is **https://visualsprint-web-5ieahiycsa-uw.a.run.app**.
This branch has not been deployed; its new paths are not evidence of that deployment's current behavior.

1. **Sign up / log in** — email + password via Supabase Auth. First login auto-creates
   your personal org.
2. **Capture a meeting** — after provider/STT configuration and disclosure:
   - **Capture now** (`/capture`) — paste a supported invitation link; calendar OAuth is not required.
     Optionally save it to a project, or keep it owner-private in Unassigned.
   - **Calendar** (`/calendar`) — connect your calendar and enable automatic scheduling policy.
     Both paths use durable v2 requests; admission and real capture still require live qualification.
   - Historical recording upload remains in `/upload`; companion/RTMS/artifact integrations are
     legacy paths, not the current pilot capture guarantee.
3. **Follow capture status** — queued, joining/admission and capturing are separate states. Reopen a
   recent request after refresh. Stop is confirmed only after provider departure. On provider end,
   final transcript feeds understand → verify → memory → report. This lane collects no screenshots.
4. **Open the report** (`/meetings`) — see decisions, commitments and blockers with transcript evidence.
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
