"""Application settings. All secrets come from environment / .env — never hardcoded."""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Resolved relative to this file, not the process's cwd -- pydantic-settings'
# default "relative to cwd" behavior silently finds nothing when uvicorn is
# launched from the repo root with --app-dir backend (cwd stays the repo
# root; --app-dir only affects the Python import path), which is exactly how
# .claude/launch.json's "backend" config runs it.
_ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=_ENV_FILE, env_prefix="VS_", extra="ignore")

    # --- Core ---
    env: str = "dev"
    database_url: str = (
        "postgresql+psycopg://visualsprint:visualsprint_dev@localhost:5433/visualsprint"
    )

    # --- Blob storage (S3-compatible; R2 in prod, local dir in dev) ---
    blob_backend: str = "local"  # "local" | "s3" | "gcs"
    blob_local_dir: str = ".blobstore"
    s3_endpoint_url: str | None = None  # R2: https://<account>.r2.cloudflarestorage.com
    s3_bucket: str = "visualsprint"
    s3_access_key_id: str | None = None
    s3_secret_access_key: str | None = None
    # GCS backend (recommended for GCP deployments -- uses ADC, no key file needed).
    # Production sets this to "visualsprint-blobs-${PROJECT_ID}" via VS_GCS_BUCKET
    # in deploy.yml (GCS bucket names are globally unique -- a generic name is
    # almost certainly taken by another GCP project).
    gcs_bucket: str = "visualsprint-blobs"

    # --- Zoom RTMS (Mode A1 real-time capture; see backend/app/capture/rtms_*.py) ---
    zoom_client_id: str | None = None
    zoom_client_secret: str | None = None
    zoom_webhook_secret_token: str | None = None
    # Server-to-Server OAuth's account_credentials grant requires the real
    # Zoom account ID -- the literal string "me" is rejected. Found on the
    # app's "App Credentials" page (labeled "Account ID").
    zoom_account_id: str | None = None

    # --- SecretStore (OAuth token storage; "local" dev writes plaintext to
    # disk, "gcp" prod uses Secret Manager -- app/interfaces/secretstore.py) ---
    secretstore_backend: str = "local"  # "local" | "gcp"
    secretstore_local_dir: str = ".secretstore"

    # --- OAuth (per-org vendor connections -- app/oauth/. One app
    # registration per vendor covers every customer org; each org
    # authorizes it individually via the standard redirect-consent flow,
    # never by pasting an API key. See CalendarConnection/secret_ref.) ---
    oauth_redirect_base_url: str = "http://localhost:8000"
    # Where a completed connection redirects the user's browser back to
    # (frontend/app/settings/connections/page.tsx) -- separate from
    # oauth_redirect_base_url, which is the *backend's* own callback URL
    # registered with each vendor.
    frontend_base_url: str = "http://localhost:3000"
    # Signs the OAuth `state` param (app/oauth/flow.py) so a callback can
    # trust which org a grant belongs to without a separate state-storage
    # table. Required in any environment serving real traffic -- unset is
    # fine for local dev/tests where nothing signs or verifies state.
    oauth_state_secret: str | None = None
    google_oauth_client_id: str | None = None
    google_oauth_client_secret: str | None = None
    slack_oauth_client_id: str | None = None
    slack_oauth_client_secret: str | None = None
    jira_oauth_client_id: str | None = None
    jira_oauth_client_secret: str | None = None
    github_oauth_client_id: str | None = None
    github_oauth_client_secret: str | None = None
    linear_oauth_client_id: str | None = None
    linear_oauth_client_secret: str | None = None
    zoom_oauth_client_id: str | None = None
    zoom_oauth_client_secret: str | None = None
    microsoft_oauth_client_id: str | None = None
    microsoft_oauth_client_secret: str | None = None

    # --- End-user authentication (Supabase Auth -- app/auth/) ---
    # Backend only verifies tokens against the project's public JWKS
    # endpoint; no service-role key is needed here.
    supabase_url: str | None = None

    # --- ASR vendors (buy-everything strategy; see docs/PROJECT_PLAN.md) ---
    google_credentials_json: str | None = None  # path to service-account JSON
    azure_speech_key: str | None = None
    azure_speech_region: str | None = None
    groq_api_key: str | None = None
    huggingface_token: str | None = None  # pyannote diarization pipelines are HF-gated
    # Speaker separation is optional. Preserve the transcript/report path when
    # the gated model has not been approved or cannot fit the worker budget.
    diarization_enabled: bool = True

    # --- Agents (Gemini via Vertex AI by default as of 2026-08-11 -- Claude
    # on Vertex/Foundry remain available behind the same LlmClient interface
    # but are no longer the default: Anthropic's partner models on Vertex
    # default new projects to zero quota per base model, requiring a manual
    # quota-increase request, while Gemini is first-party and unblocked
    # immediately. See app/adapters/llm_gemini_vertex.py's docstring for the
    # full reasoning and CLAUDE.md's note on this.) ---
    llm_provider: str = "gemini"  # "gemini" | "vertex" (Claude) | "foundry" (Claude)
    anthropic_api_key: str | None = None
    vertex_project_id: str | None = None
    vertex_region: str = "us-east5"
    # Gemini's Vertex region availability differs from Claude's partner-model
    # availability -- verified empirically, not guessed (see
    # app/adapters/llm_gemini_vertex.py).
    gemini_region: str = "us-central1"
    # Microsoft Foundry (Azure) -- api_key auth against
    # https://{foundry_resource}.services.ai.azure.com/anthropic/.
    foundry_api_key: str | None = None
    foundry_resource: str | None = None
    model_extract: str = "gemini-2.5-pro"
    model_classify: str = "gemini-2.5-flash-lite"
    model_memory: str = "gemini-2.5-pro"
    model_verify: str = "gemini-2.5-pro"
    model_report: str = "gemini-2.5-pro"
    model_repair: str = (
        "gemini-2.5-flash-lite"  # cheap, high-volume: every ASR segment goes through this
    )

    # --- Worker ---
    worker_poll_seconds: float = 2.0
    # Max RUNNING jobs per org at once -- prevents one org bulk-uploading
    # hundreds of recordings from starving every other tenant in a global FIFO.
    worker_max_inflight_per_org: int = 2
    # Safety cap on one Cloud Scheduler-triggered pass (VS_WORKER_MODE=http)
    # -- keeps a single invocation from running indefinitely if the queue is
    # deep, so the container reliably returns and can scale back to zero.
    # Comfortably under Cloud Run's request timeout (set to 3600s for this
    # service in deploy.yml).
    worker_pass_max_seconds: float = 300.0
    job_max_attempts: int = 5
    # How often the worker polls every CalendarConnection for new events
    # (app/orchestrator/scheduler.py). Deliberately much coarser than the
    # job-queue poll -- calendar APIs have real rate limits and events don't
    # change second-to-second the way pipeline jobs do.
    calendar_sync_interval_s: float = 300.0
    # How often the worker sweeps orgs with Org.retention_days set for
    # expired raw evidence to purge (app/orchestrator/retention.py). Coarser
    # still than calendar sync -- not time-critical to the hour, let alone
    # the minute.
    retention_sweep_interval_s: float = 3600.0
    # How often the worker retries transcoding AudioTrack blobs that were
    # stored non-FLAC because ffmpeg was unavailable at ingest time
    # (app/orchestrator/transcode_backfill.py). Same coarse cadence as
    # retention -- this only matters once ffmpeg gets provisioned in an
    # environment where it wasn't before, not a steady-state concern.
    transcode_backfill_interval_s: float = 3600.0
    # How often the worker checks for the two time-driven action triggers --
    # recurring-blocker escalation and approaching-due-date commitment
    # reminders (app/orchestrator/action_triggers.py). Same cadence as
    # calendar sync: these are the automations most likely to be
    # user-visibly late if checked too coarsely, unlike retention/backfill.
    action_trigger_interval_s: float = 300.0
    lifecycle_sweep_interval_s: float = 300.0
    work_tracking_interval_s: float = 900.0
    # How often the worker checks for BotSession rows due to join
    # (app/bot/runner.py, Mode B). Deliberately tighter than calendar sync --
    # a bot that dispatches even a minute or two late can miss the start of
    # a short meeting, whereas calendar events themselves rarely change
    # minute-to-minute.
    bot_dispatch_interval_s: float = 60.0
    # A BotSession becomes eligible this far ahead of its scheduled_start so
    # the join has time to complete before the meeting actually begins.
    bot_dispatch_lookahead_s: float = 120.0
    # Caps concurrently-live bot joins per worker process -- each one holds
    # an open headless-Chromium page for the duration of a meeting, so this
    # is a real resource ceiling, not just a rate limit.
    bot_max_concurrent: int = 3
    # Off by default -- a live bot must stay attached to its browser page
    # for the whole meeting (up to MAX_MEETING_S in app/bot/runner.py),
    # which the scale-to-zero `visualsprint-agents` Cloud Run service
    # (--cpu-throttling, --min-instances=0, invoked briefly by Cloud
    # Scheduler) cannot provide: the container is starved/recycled the
    # moment the triggering HTTP request completes, so a bot join would get
    # silently cut off mid-meeting rather than fail loudly. Flip this to
    # true only once Mode B has its own always-on host (a Cloud Run service
    # with --min-instances=1 --no-cpu-throttling, or an equivalent VM) --
    # that is a real recurring cost (~$60+/month, see .github/workflows/
    # deploy.yml's cost notes), not something to switch on implicitly.
    # calendar sync still creates BotSession rows when this is off; they
    # simply sit SCHEDULED, un-dispatched, until enabled.
    bot_dispatch_enabled: bool = False
    # "local" uses asyncio.create_task inside the worker process (dev/test
    # only -- the process must stay alive for the whole meeting).
    # "cloud_run_job" invokes the Cloud Run Jobs API to start an independent
    # job execution per BotSession (production -- pay per second, no always-on
    # cost, no process longevity requirement on the agents service).
    bot_dispatch_mode: str = "local"  # "local" | "cloud_run_job"
    # Cloud Run Job target. Only read when bot_dispatch_mode="cloud_run_job".
    bot_cloud_run_job_name: str = "visualsprint-bot"
    # GCP project and region for the bot job. Must be set explicitly --
    # the metadata server project/region are not consulted during Settings
    # parsing, only at runtime inside the adapter.
    bot_cloud_run_project: str | None = None
    bot_cloud_run_region: str | None = None
    # Optional runtime shortenings for production smoke tests. Leave unset for
    # normal meetings; set on the Cloud Run Job only when validating the bot.
    bot_lobby_timeout_s: float | None = None
    bot_max_meeting_s: float | None = None
    bot_smoke_capture_seconds: float | None = None
    # The production-safe Meet mode is ``guest``: no Google browser cookie is
    # loaded, so a Workspace meeting that permits invited guests / everyone
    # with the link can be joined indefinitely without periodic re-login.
    # ``session`` is an emergency legacy compatibility mode only. Google owns
    # the lifetime of browser cookies and may revoke them at any time; OAuth
    # refresh tokens cannot renew those browser cookies.
    bot_google_join_mode: str = "guest"  # "guest" | "session"
    # Path to Playwright storage_state JSON. Read only when
    # bot_google_join_mode="session"; ignored in the durable guest mode.
    bot_google_storage_state_path: str | None = None
    # Non-secret identity of the dedicated bot account. The UI uses this to
    # tell organizers which account to invite before the meeting starts.
    bot_google_account_email: str | None = None
    # Person-level analysis can multiply LLM spend through the high-stakes
    # ensemble. It is fully wired but opt-in so local/test deployments and
    # budget-constrained projects never incur surprise vendor calls.
    longitudinal_analysis_enabled: bool = False
    longitudinal_analysis_interval_s: float = 86400.0
    longitudinal_analysis_window_days: int = 90
    longitudinal_ensemble_size: int = 3
    # How far ahead of a commitment's due date to start proposing a
    # reminder (also covers already-overdue commitments).
    action_trigger_reminder_window_hours: float = 24.0

    # --- API ---
    # Per-IP rate limiter on upload and Zoom webhook routes (per-instance,
    # not distributed -- a blunt guard, not a quota).
    rate_limit_enabled: bool = True
    rate_limit_window_s: float = 60.0
    rate_limit_upload_per_window: int = 10
    rate_limit_webhook_per_window: int = 200
    # pydantic-settings decodes list-typed env vars as JSON, e.g.
    # VS_CORS_ALLOWED_ORIGINS=["https://app.example.com","https://staging.example.com"]
    cors_allowed_origins: list[str] = ["https://visualsprint-web-5ieahiycsa-uw.a.run.app"]


@lru_cache
def get_settings() -> Settings:
    return Settings()
