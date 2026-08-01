"""Application settings. All secrets come from environment / .env — never hardcoded."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="VS_", extra="ignore")

    # --- Core ---
    env: str = "dev"
    database_url: str = "postgresql+psycopg://visualsprint:visualsprint_dev@localhost:5433/visualsprint"

    # --- Blob storage (S3-compatible; R2 in prod, local dir in dev) ---
    blob_backend: str = "local"  # "local" | "s3"
    blob_local_dir: str = ".blobstore"
    s3_endpoint_url: str | None = None  # R2: https://<account>.r2.cloudflarestorage.com
    s3_bucket: str = "visualsprint"
    s3_access_key_id: str | None = None
    s3_secret_access_key: str | None = None

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

    # --- Worker ---
    worker_poll_seconds: float = 2.0
    job_max_attempts: int = 5


@lru_cache
def get_settings() -> Settings:
    return Settings()
