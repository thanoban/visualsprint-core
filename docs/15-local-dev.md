# Local Development Guide

How to run the full stack locally — including RTMS, bot join, and pipeline agents.

## Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| Docker Desktop | any | Postgres via docker-compose |
| Python | 3.12 | Backend |
| Node.js | 18+ | Frontend |
| ngrok | any | Public tunnel for Zoom webhooks |

---

## Step 1 — Start the database

```bash
cd infra
docker compose up -d db
```

Postgres listens on `localhost:5433`. Leave this running throughout your session.

---

## Step 2 — Backend install

```bash
cd backend
python -m venv .venv

# Windows
.venv\Scripts\activate

# macOS/Linux
source .venv/bin/activate

# Install base + dev + storage + bot extras
pip install -e ".[dev,storage,bot]"

# Install Chromium (needed for bot join)
playwright install chromium --with-deps
```

---

## Step 3 — Start ngrok

Zoom webhooks (RTMS) and OAuth callbacks must reach your machine from the internet.

```bash
ngrok http 8000
```

Note the HTTPS URL it prints, e.g. `https://abc123.ngrok-free.app`. You need this for
the `.env` file below and for the Zoom webhook URL (see Step 6).

> ngrok free-tier URLs change on every restart. If you stop and restart ngrok, repeat
> Step 6 (update Zoom webhook URL) for RTMS to keep working.

---

## Step 4 — Create `backend/.env`

Copy the template and fill in the values. Secret values can be read from GCP Secret Manager:

```bash
gcloud secrets versions access latest \
  --secret=<secret-name> --project=visualsprint-agent
```

```dotenv
# ── Core ────────────────────────────────────────────────────────────────────
VS_DATABASE_URL=postgresql+psycopg://visualsprint:visualsprint_dev@localhost:5433/visualsprint
VS_SUPABASE_URL=https://uktfgmvmtijqpzqnivvi.supabase.co

# Local backends — no GCP needed for storage or secrets
VS_SECRETSTORE_BACKEND=local
VS_BLOB_BACKEND=local

# Public URLs — use your ngrok address for the API, localhost for the frontend
VS_OAUTH_REDIRECT_BASE_URL=https://abc123.ngrok-free.app
VS_FRONTEND_BASE_URL=http://localhost:3000

# ── OAuth clients ────────────────────────────────────────────────────────────
# Read from Secret Manager: visualsprint-oauth-state-secret
VS_OAUTH_STATE_SECRET=<value>

# Google — visualsprint-google-oauth-client-id / ...-secret
VS_GOOGLE_OAUTH_CLIENT_ID=<value>
VS_GOOGLE_OAUTH_CLIENT_SECRET=<value>

# Microsoft — visualsprint-microsoft-oauth-client-id / ...-secret
VS_MICROSOFT_OAUTH_CLIENT_ID=<value>
VS_MICROSOFT_OAUTH_CLIENT_SECRET=<value>

# Zoom General OAuth app — visualsprint-zoom-oauth-client-id / ...-secret
VS_ZOOM_OAUTH_CLIENT_ID=<value>
VS_ZOOM_OAUTH_CLIENT_SECRET=<value>

# ── Zoom RTMS (Server-to-Server app) ────────────────────────────────────────
# visualsprint-zoom-client-id / ...-secret / ...-webhook-secret-token
VS_ZOOM_CLIENT_ID=<value>
VS_ZOOM_CLIENT_SECRET=<value>
VS_ZOOM_WEBHOOK_SECRET_TOKEN=<value>
VS_ZOOM_ACCOUNT_ID=8wM2gxaXRze71LGSsRNTOA

# ── Bot ─────────────────────────────────────────────────────────────────────
# local mode: worker runs the bot directly in-process via asyncio.create_task
# (no Cloud Run Job needed). Keep bot_max_concurrent low — each bot holds
# an open Chromium page for the full meeting duration.
VS_BOT_DISPATCH_ENABLED=true
VS_BOT_DISPATCH_MODE=local
VS_BOT_MAX_CONCURRENT=2

# ── Pipeline agents (optional — needed for transcribe/understand/report) ────
# Download the service-account JSON once:
#   gcloud secrets versions access latest \
#     --secret=visualsprint-google-speech-credentials \
#     --project=visualsprint-agent > /tmp/google-speech.json
VS_GOOGLE_CREDENTIALS_JSON=/tmp/google-speech.json

# visualsprint-azure-speech-key / ...-region
VS_AZURE_SPEECH_KEY=<value>
VS_AZURE_SPEECH_REGION=<value>

# LLM provider — gemini works with ADC (no extra key needed on GCP project)
# Set VS_VERTEX_PROJECT_ID if ADC doesn't pick up the project automatically
VS_LLM_PROVIDER=gemini
# VS_VERTEX_PROJECT_ID=visualsprint-agent
```

---

## Step 5 — Run migrations and start the API

```bash
cd backend
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

API is at `http://localhost:8000`. The ngrok tunnel forwards
`https://abc123.ngrok-free.app` → `http://localhost:8000`.

---

## Step 6 — Point Zoom webhooks at ngrok (RTMS)

In Zoom Marketplace → your **RTMS Server-to-Server** app → Event Subscriptions:

Change the Event notification URL from:
```
https://visualsprint-api-5ieahiycsa-uw.a.run.app/api/v1/webhooks/zoom/rtms
```
to:
```
https://abc123.ngrok-free.app/api/v1/webhooks/zoom/rtms
```

Save. **Revert this when you stop local dev** so the production app keeps working.

Also update the **General OAuth app**'s redirect URI (for Zoom Connect in Settings):
```
https://abc123.ngrok-free.app/api/v1/oauth/zoom/callback
```

---

## Step 7 — Start the worker (separate terminal)

The worker handles calendar sync, bot dispatch, and pipeline stages.

```bash
cd backend
.venv\Scripts\activate   # or source .venv/bin/activate

# Runs as an infinite poll loop (not http mode like production)
python -m app.orchestrator.worker
```

Leave this running alongside the API. You'll see log lines for each sweep:
- `calendar_sync.ok` — found meetings, created BotSession rows
- `bot_dispatch.dispatched` — bot launched for a meeting
- `pipeline.stage.*` — upload pipeline progressing

---

## Step 8 — Frontend

```bash
cd frontend
npm install
```

Create `frontend/.env.local`:
```dotenv
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
NEXT_PUBLIC_SUPABASE_URL=https://uktfgmvmtijqpzqnivvi.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<from Supabase project settings → API>
```

```bash
npm run dev
```

App is at **http://localhost:3000**.

---

## Feature availability

| Feature | Local | Notes |
|---|---|---|
| Sign up / login | ✅ | Supabase Auth, same as prod |
| Upload + pipeline (Mode D) | ✅ | Runs fully locally |
| Google OAuth (calendar connect) | ✅ | Needs ngrok URL in VS_OAUTH_REDIRECT_BASE_URL |
| Microsoft OAuth | ✅ | Same |
| Zoom OAuth (General app) | ✅ | Same |
| RTMS live capture (Zoom) | ✅ | Needs Step 6 — ngrok URL in Zoom webhook settings |
| Bot join (Google Meet / Teams) | ✅ | `VS_BOT_DISPATCH_MODE=local`, Chromium runs in-process |
| Transcription (Google + Azure) | ✅ | Needs `VS_GOOGLE_CREDENTIALS_JSON` + `VS_AZURE_SPEECH_KEY` |
| LLM agents (understand/report) | ✅ | Needs GCP ADC (`gcloud auth application-default login`) |
| GCS blob store | ❌ | Use `VS_BLOB_BACKEND=local` — files go to `backend/.blobstore/` |
| GCP Secret Manager | ❌ | Use `VS_SECRETSTORE_BACKEND=local` — tokens go to `backend/.secretstore/` |

---

## Common issues

**`alembic upgrade head` fails — connection refused**
Docker Desktop isn't running, or the db container isn't up. Run `docker compose up -d db` first.

**Bot never joins a meeting**
- Check the worker is running and `VS_BOT_DISPATCH_ENABLED=true`
- The scheduler looks ahead `VS_BOT_DISPATCH_LOOKAHEAD_S=120` seconds — schedule the
  meeting at least 2 minutes in the future
- Chromium must be installed: `playwright install chromium --with-deps`

**RTMS: `meeting.rtms_started` never fires after `meeting.started`**
- The ngrok URL in Zoom's webhook settings must match what's running
- Check ngrok is still alive (free tier URLs expire on restart)
- Check the API logs for `failed to get S2S token` — means `VS_ZOOM_CLIENT_ID`/`SECRET`
  or `VS_ZOOM_ACCOUNT_ID` is wrong

**OAuth callback: `Internal Server Error`**
- `VS_OAUTH_REDIRECT_BASE_URL` must be the ngrok URL (not `localhost:8000`) so Google/
  Zoom/Microsoft redirect back to a publicly reachable address
- Google OAuth app must have your email in **test users** (Google Cloud Console →
  APIs & Services → OAuth consent screen → Test users)

**`import google.cloud.secretmanager` fails**
You're running with `VS_SECRETSTORE_BACKEND=gcp` but the `storage` extra isn't installed.
Either set `VS_SECRETSTORE_BACKEND=local` (recommended for local dev) or
`pip install -e ".[storage]"`.

---

## Stopping / cleanup

```bash
# Stop frontend: Ctrl-C in the npm run dev terminal
# Stop API: Ctrl-C in the uvicorn terminal
# Stop worker: Ctrl-C in the worker terminal
# Stop ngrok: Ctrl-C in the ngrok terminal
# Stop DB:
cd infra && docker compose down

# Revert Zoom webhook URL to production (important!)
# Zoom Marketplace → RTMS app → Event Subscriptions →
# restore: https://visualsprint-api-5ieahiycsa-uw.a.run.app/api/v1/webhooks/zoom/rtms
```
