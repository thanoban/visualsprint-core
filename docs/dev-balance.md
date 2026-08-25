# VisualSprint — Dev Balance
*Solo founder · 2026-08-24 · visualsprint-agent (GCP)*

---

## Current state at a glance

| What | State |
|------|-------|
| Tests | **587 passing, 0 failing** |
| mypy gate | **392 errors (baseline clean)** |
| Live end-to-end captures | **0** — never completed |
| Bot join | Fixed this session (pending deploy) |
| Transcription (chirp_2) | Fixed this session (blob_store + OOM) |
| GCP spend | ≈ $0 (all services scale to zero) |

The architecture is solid, tests are green, but **zero meetings have ever been captured end-to-end in production**. Every downstream feature (agents, reports, chat, speaker identity) has only run against fakes.

---

## Priority map

### Do first — high impact, low effort

- Reconnect Google/Microsoft calendars (manual — old tokens wiped when secretstore fixed)
- Run first supervised live capture from start to report
- Add Groq API key (English ASR path is silent without it)
- Build the meeting list page (no way to see past meetings in the UI)
- Verify Azure ASR appears in logs after the first live run

### Plan carefully — high impact, high effort

- Fix diarization: accept pyannote model terms on HuggingFace
- Bot screen keyframes → OCR pipeline (speech↔screen grounding gap)
- Speaker identity threshold tuning (needs real audio first)
- RTMS reliability: move to Cloud Run Job per stream
- Google bot session auto-refresh (sessions expire silently)

### Fill in as time allows — lower impact, low effort

- Groq English path end-to-end test
- Landing page conversion tuning
- Org-wide digest email
- Correction UI glossary flywheel

### Defer or skip

- Temporal / Celery migration
- Custom ASR training
- CRM sync (HubSpot / Salesforce)
- Teams Graph API capture
- Neo4j / dedicated vector DB

---

## NOW — this week

### 1. Reconnect Google/Microsoft calendars
**Status: MANUAL ACTION REQUIRED**

The `VS_SECRETSTORE_BACKEND=gcp` fix saved future tokens to Secret Manager, but the old tokens lived on ephemeral container disk — they are gone. Every user must re-authorize in **Settings → Connections**. Without this, the calendar sync sweep sees nothing, no meetings are created, no bot sessions are dispatched automatically.

*Action: Settings → Connections → Google Calendar → Reconnect*

---

### 2. Supervised first live capture run
**Status: URGENT — do this immediately after bot deploys**

Once the current CI run deploys `0fe3126` (Google session v3 + join fix), start a real Google Meet and use "Capture now". Watch Cloud Run logs for `visualsprint-bot` then `visualsprint-agents`. Every pipeline stage — chirp_2, diarization, identity fusion, five agents, report generation — will make first contact with real audio.

Expect 2–3 unexpected failures. Log them, fix them, repeat. This hour is more valuable than any feature.

*Action: Cloud Run → visualsprint-bot logs → visualsprint-agents logs*

---

### 3. Groq API key — wire English transcription
**Status: MISSING**

English audio enters the cascade but Groq has no key, so the call fails and the span is marked no-transcript. For English-heavy meetings this silently drops content.

Steps:
1. Create a free Groq account at console.groq.com
2. Generate an API key
3. `gcloud secrets create visualsprint-groq-api-key --project=visualsprint-agent --data-file=-` (pipe the key)
4. Add to `.github/workflows/deploy.yml` agents secrets block

---

### 4. Verify Azure Speech in live logs
**Status: VERIFY (no code change)**

Azure key + region are mounted on agents. The adapter has never been called against real audio. After the first live run, search logs for `azure:si-LK` or `azure:ta-IN`. Confirm it responds or note the error. Only called for si/ta spans where chirp_2 returns empty or low-confidence.

---

## SOON — this month

These items are only worth doing **after the first real run**. Building on top of an unverified pipeline is building on sand.

---

### Meeting list page
**Status: MISSING — critical gap**

There is no page to see past meetings. The data model is correct. The report page exists. But there is no listing to navigate from. The plan doc flags this as the missing foundation for Projects, catchup story, and the dashboard.

Minimum viable:
- `GET /api/v1/orgs/{id}/meetings` — return `id, title, platform, scheduled_start, latest capture state, coverage-gap flag`
- `backend/app/api/meetings.py` (new router)
- `frontend/app/meetings/page.tsx` (listing page with card + state + date)
- Repoint sidebar "Meetings" link from `/` to `/meetings`

Without this, captured meetings are invisible.

---

### Fix diarization — pyannote HuggingFace access
**Status: 5-minute fix, currently falls back to 1 speaker**

The HuggingFace token is configured but the account has not accepted pyannote's model terms. Every meeting shows "Speaker 1" for all participants.

*Action: huggingface.co/pyannote/speaker-diarization-community-1 → Accept terms → test pipeline*

---

### Bot screen keyframes → OCR pipeline
**Status: USP gap**

The bot captures audio but discards screen frames (runner's drain loop explicitly drops them to avoid OOM). The screen/OCR pipeline (`app/screen/`) exists and works. Without feeding bot frames into it, bot-captured meetings have zero screen evidence in reports.

The speech↔screen grounding feature — the primary competitive differentiator — only appears in reports for upload-mode (Mode D) captures, not bot-mode (Mode B) captures.

Minimum fix: modify `bot/runner.py` to write key frames to GCS (`bot-debug/` bucket prefix) instead of discarding, then enqueue them through the existing `screen_extract` pipeline stage.

---

### Speaker identity threshold tuning
**Status: data-first — cannot start until real audio exists**

`VOICEPRINT_MATCH_THRESHOLD` and `MARGIN` in `app/speakers/identity.py` are set conservatively (prefer UNRESOLVED over a wrong guess). These cannot be calibrated against fakes or silence. After 5–10 real meetings, check how many utterances resolve correctly vs stay UNRESOLVED and adjust.

---

### Google bot session auto-refresh
**Status: maintenance — will break again silently**

Google expires session cookies when the container runs from a new IP or after inactivity. The current fix is manual. When it breaks again, logs show `bot.meet.session_expired`. Minimum: an alert when this fires so it doesn't go unnoticed for days. Better: a Cloud Scheduler job that validates the session weekly.

---

## LATER — when users exist

None of these are worth building until at least one external user is active.

| Feature | Why it matters | Precondition | Effort |
|---------|---------------|-------------|--------|
| RTMS streaming reliability | In-memory state dies on scale-to-zero. Required for Zoom-primary orgs. | First Zoom RTMS customer | L |
| Projects / Groups | Org structure for multi-team customers. | First multi-team customer | M |
| Catch-me-up story | Narrative across a set of meetings. Strongest differentiator. | Projects + 10+ meetings | L |
| Short shareable links | Share a report as an org-members-only URL. | Projects feature | S |
| Dashboard (n8n-style) | Meeting category cards + cross-project knowledge connections. | Catch-me-up story | L |
| Zoom Cloud Recording (Mode A2) | Higher quality than bot. Code ready, untested live. | First Zoom-paying org | S |
| CRM sync | HubSpot/Salesforce field sync. High value for sales teams. | First sales-team customer | XL |
| User onboarding flow | Self-serve: sign-up → first capture in < 5 min. | First external user | M |
| Billing + usage limits | Per-org LLM spend caps. | First paid customer | M |

---

## What's actually built (and what's proven)

| Component | State | Real-data verified? |
|-----------|-------|-------------------|
| Postgres FSM orchestrator | Production, scale-to-zero | Partial — queue logic yes; all stage handlers no |
| Mode D upload capture | Working | Yes — proven end-to-end |
| Mode B bot (Meet) | Fixed this session | Partial — join fixed; capture output not yet in report |
| Mode A1 Zoom RTMS | Wired | No — zero real RTMS sessions |
| Google chirp_2 multilingual ASR | Fixed this session | No — never run against real audio |
| Azure Speech fallback | Wired | No — never called |
| Diarization (pyannote) | Running, always 1 track | No — model gated |
| 5 session agents + 4 person agents | Implemented | No — fake LLM in all tests |
| Org-memory chat (pgvector + FTS) | Implemented | No — empty DB |
| Report UI + action approval | Implemented | No — never rendered real content |
| Calendar sync (Google + Microsoft) | Fixed secretstore | Partial — needs reconnect |
| 6 automation connectors | Implemented | No — no approved action ever executed |
| Auth, CORS, rate limits, mypy | Clean | Yes |

---

## Cost guardrails

Stay on the GCP trial credit. All services are scale-to-zero.

| Service | Config | Zero-users cost | Watch out for |
|---------|--------|----------------|---------------|
| visualsprint-api | cpu-throttling, min=0, max=2 | ≈ $0 | Keep cpu-throttling on; RTMS mode needs it off which costs ~$30/mo |
| visualsprint-agents | cpu-throttling, min=0, max=2, 1Gi | ≈ $0 | Memory stable now (~200MB after removing torch/speechbrain) |
| visualsprint-bot (Job) | per-execution, 2Gi, 4h max | $0 | $0.048/hr per execution; 20 meetings/month ≈ $1 |
| Google chirp_2 | $0.016/min multilingual | $0 | 1-hr meeting ≈ $1; 20 meetings/month ≈ $20 |
| Gemini 2.5 Pro (agents) | Default, no quota gate | $0 | 5 agents × 1 meeting ≈ $0.10–0.30; don't enable longitudinal without tracking |
| GCS blob store | visualsprint-blobs-visualsprint-agent | ≈ $0.02/GB/month | Bot audio ≈ 50MB/hour; clean bot-debug/ regularly |
| Artifact Registry | Cleanup: keep 3, delete > 7 days | ≈ $0 | Was 82GB before policy; monitor after deploy bursts |

---

## What to never build at this stage

**Temporal / Celery** — Postgres FSM handles current scale. Temporal is the documented upgrade path for 1000+ concurrent jobs.

**Custom ASR training** — chirp_2 handles Sinhala/Tamil/English code-switching. Training costs GPU time and labelled data. No user has complained about quality.

**Neo4j or dedicated vector DB** — pgvector + FTS covers the knowledge graph at this scale. Porting doubles infrastructure complexity.

**CRM sync** — High-maintenance integration for a customer segment (sales teams) that doesn't exist yet.

**Teams Graph API** — Requires Microsoft partner approval. No Teams customer exists. Code is wired; don't spend more time on it.

**Production monitoring stack** — Cloud Run structured logs + an error-rate alert is sufficient without SLA commitments.

**Multi-region / HA** — Single region (us-west1) is fine. Multi-region is ~3× infra cost for an SLA nobody has contracted.

**Mobile app** — The use case (post-meeting review) suits a responsive web app. Mobile is a year-2 priority.

---

## The one thing that changes everything

**Get one real meeting captured, transcribed, and turned into a report.**

Every architectural decision — evidence-grounding, anti-hallucination rules, multilingual cascade, speech↔screen grounding — is proven in tests but unproven on real audio. One supervised end-to-end run will surface more real bugs than another month of feature-building.

The meeting list page and calendar reconnect are the only changes needed to make that run useful. Everything else in this document is a consequence of what that run reveals.
