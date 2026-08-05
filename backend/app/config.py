"""Application settings. All secrets come from environment / .env — never hardcoded."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="VS_", extra="ignore")

    # --- Core ---
    env: str = "dev"
    database_url: str = (
        "postgresql+psycopg://visualsprint:visualsprint_dev@localhost:5433/visualsprint"
    )

    # --- Blob storage (S3-compatible; R2 in prod, local dir in dev) ---
    blob_backend: str = "local"  # "local" | "s3"
    blob_local_dir: str = ".blobstore"
    s3_endpoint_url: str | None = None  # R2: https://<account>.r2.cloudflarestorage.com
    s3_bucket: str = "visualsprint"
    s3_access_key_id: str | None = None
    s3_secret_access_key: str | None = None

    # --- Zoom RTMS (Mode A1 real-time capture; see backend/app/capture/rtms_*.py) ---
    zoom_client_id: str | None = None
    zoom_client_secret: str | None = None
    zoom_webhook_secret_token: str | None = None

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

    # --- ASR vendors (buy-everything strategy; see docs/PROJECT_PLAN.md) ---
    google_credentials_json: str | None = None  # path to service-account JSON
    azure_speech_key: str | None = None
    azure_speech_region: str | None = None
    groq_api_key: str | None = None
    huggingface_token: str | None = None  # pyannote diarization pipelines are HF-gated

    # --- Agents (Claude via Vertex AI; auth is GCP Application Default Credentials) ---
    anthropic_api_key: str | None = None
    vertex_project_id: str | None = None
    vertex_region: str = "us-east5"
    model_extract: str = "claude-sonnet-5"
    model_classify: str = "claude-haiku-4-5-20251001"
    model_memory: str = "claude-opus-4-8"
    model_verify: str = "claude-sonnet-5"
    model_report: str = "claude-sonnet-5"
    model_repair: str = "claude-haiku-4-5-20251001"  # cheap, high-volume: every ASR segment goes through this

    # --- Worker ---
    worker_poll_seconds: float = 2.0
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
    # How far ahead of a commitment's due date to start proposing a
    # reminder (also covers already-overdue commitments).
    action_trigger_reminder_window_hours: float = 24.0

    # --- API ---
    # pydantic-settings decodes list-typed env vars as JSON, e.g.
    # VS_CORS_ALLOWED_ORIGINS=["https://app.example.com","https://staging.example.com"]
    cors_allowed_origins: list[str] = ["http://localhost:3000"]


@lru_cache
def get_settings() -> Settings:
    return Settings()
