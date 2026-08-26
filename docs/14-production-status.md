# Production Status — Capture Layer

Live-verified state of the deployed system, kept current as incidents are found and
fixed. Unlike `06-roadmap.md` (what's built) this tracks **what's actually working in
`visualsprint-agent`** — verified against Cloud Run logs, IAM, and the production DB,
not assumed from the codebase. Update this file whenever a production capture bug is
diagnosed or fixed; don't let it go stale like the roadmap's "not runtime-verified"
caveats did.

## 2026-08-18 incident — zero meetings ever captured

Audited after repeated reports that neither the Meet bot nor Zoom RTMS produced any
insights. Queried the production DB directly: `meeting`, `capture_session`, and
`bot_session` tables were all **empty** — every capture path had failed at its first
step since the feature was deployed, not merely produced degraded output.

### Root causes found (ranked by blast radius)

**A. OAuth tokens written to ephemeral container disk, not Secret Manager.**
`VS_SECRETSTORE_BACKEND=gcp` was set on the bot Cloud Run Job only —
not on the `api` or `agents` services in `deploy.yml`. Both defaulted to the
`local` backend (`app/adapters/secretstore_local.py`), which writes to the
container's own disk. Effect: connecting Google/Microsoft calendar wrote real
tokens, but to a disk (a) wiped on next deploy and (b) never visible to the
`agents` worker container in the first place. Worker logs showed
`calendar_sync.failed ... secret not found: 'oauth/google/<uuid>'` every 6
minutes for days. No calendar sync → no `Meeting` rows → no `BotSession` rows
→ the bot dispatch sweep had nothing to act on → **the bot Cloud Run Job has
zero executions, ever.** Kills: Meet bot, Teams bot, calendar-triggered
capture, Zoom Mode A2 artifact pull.

**B. Zoom S2S token request used `account_id="me"`.** Zoom's
`account_credentials` OAuth grant requires the real account ID
(`8wM2gxaXRze71LGSsRNTOA` for the VisualSprint RTMS Server app), not the
literal string `"me"`. The RTMS-activation call added on 2026-08-18
(`_enable_rtms_for_meeting` in `app/api/rtms_webhook.py`) would 400 on the
token fetch before ever reaching Zoom's RTMS endpoint.

**C. RTMS live WebSocket runs inside the `api` web service**, which Cloud Run
CPU-throttles between HTTP requests and autoscales 0→20 instances. The stream
is tracked in an in-process `dict` (`_active_streams`) — starved by
throttling, and lost entirely if `rtms_stopped` lands on a different instance
than the one holding the stream. Same class of problem the bot already solved
by moving to its own Cloud Run Job; RTMS streams need the same treatment.

**D. Nothing downstream (ASR cascade, diarization, identity, five agents,
report) has ever run against real audio** — all built and unit-tested against
fakes, zero live runs, because no audio ever arrived. First real run should be
treated as a supervised event.

### Fix status

**Update 2026-08-26** — verified directly against `.github/workflows/deploy.yml` (not assumed): A and B are done. C is deliberately deferred, not "in progress" — see the deploy.yml comment at the api deploy step, which accepts RTMS unreliability under scale-to-zero until there are paying users and budget for an always-on instance.

| Cause | Fix | Status |
|---|---|---|
| A — secretstore backend | `VS_SECRETSTORE_BACKEND=gcp` on `api` + `agents` | **done** — both `--set-env-vars` blocks in deploy.yml set it |
| A — stale tokens | User must re-connect Google + Microsoft calendars after the fix ships (old tokens are unrecoverable — lived on a wiped disk) | pending, manual — depends on end users actually reconnecting |
| B — Zoom account id | Store `visualsprint-zoom-account-id` secret, use in `_get_s2s_token` instead of `"me"` | **done** — `rtms_webhook.py`'s `_get_s2s_token` reads `settings.zoom_account_id`; secret wired into `api`'s `--set-secrets`. Not verified: whether the secret's stored value is the real account ID vs. still a placeholder — needs a live `gcloud secrets versions access` check, not just a repo read |
| C — RTMS reliability | Durable fix: move RTMS streaming to its own Cloud Run Job (mirrors the bot's `JobDispatcher`), state in DB keyed by `rtms_stream_id` | **deliberately deferred** — deploy.yml keeps `api` at `--cpu-throttling --min-instances=0`, accepting RTMS unreliability pre-revenue. Re-enable `--no-cpu-throttling --min-instances=1` only when RTMS is actively needed and the ~$60/mo always-on cost is budgeted |
| D — first live run | Supervised test pass: instant Meet capture → scheduled Meet → Zoom → Teams | planned |

### Also fixed same week (superseded, listed for the record)

- Zoom RTMS payload nesting (`payload["object"]`) and `server_urls` string-vs-dict handling — real bug, real fix, but code deployed had *no effect* until Cause A/B/C above are also fixed, since no session ever reached this code path with a real audio session.
- `WebsocketsConnector` wired via FastAPI lifespan — same caveat.
- GCS bucket name collision (`visualsprint-blobs` is globally claimed by another GCP project) — fixed by scoping to `visualsprint-blobs-${PROJECT_ID}`. This one *did* block all three Cloud Run deploys outright (`gsutil iam ch` on a nonexistent bucket), independent of A/B/C.
- Unhandled Zoom webhook events (`meeting.started`, `meeting.participant_joined`, etc.) returned 400 — Zoom treats repeated 400s as an unhealthy endpoint and throttles delivery. Now returns 200 `{"status": "ignored"}`.

## Roadmap to the per-participant intelligence USP

The differentiator — *what did each person commit to, across meetings, and did they
deliver* — is largely **already built**: identity resolution ladder, lifecycle
closure engine, work-tracker verification against Jira/GitHub/Linear, interaction
map, per-person metrics API and frontend pages (see `docs/09-participant-intelligence.md`,
`docs/13-participant-identity-capture.md`). It has never had real input. Sequence:

1. **Restore capture** (this incident, all causes above).
2. **Supervised first live runs** on all three platforms — capture the environment
   issues Cause D predicts before they become recurring confusion.
3. **Tune identity thresholds** on real Sinhala/Tamil/English code-switched audio —
   `VOICEPRINT_MATCH_THRESHOLD`/`MARGIN` in `app/identity/` are currently set
   conservatively (prefer `UNRESOLVED` over a wrong guess) and need real data, not
   more code.
4. **Wire bot screen keyframes** into report evidence (OCR stage exists; the bot's
   screenshot capture needs to feed it — see `docs/03-capture.md`'s screen-share note).
5. **Progress dashboards + org-wide digest** — the query layer
   (`app/services/participants.py`) and pages exist; this is presentation polish,
   not new plumbing.

None of step 3–5 is meaningful until step 1 lands — tuning thresholds on zero
meetings, or building a digest over an empty database, would be guesswork.
