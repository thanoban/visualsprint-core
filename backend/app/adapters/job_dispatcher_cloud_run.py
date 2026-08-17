"""Cloud Run Jobs dispatcher — calls the Cloud Run Jobs API v2 to start
a new execution of the `visualsprint-bot` job, passing the bot session ID
as an env-var override so the job entry point (app/bot/job.py) can read it.

Auth: uses the GCP Instance Metadata server to get an access token for the
ambient service account. This is the standard Cloud Run auth pattern and
requires no extra credentials or libraries beyond httpx (already a core dep).
The metadata server is only reachable on GCP infrastructure, so this adapter
must only be used when VS_BOT_DISPATCH_MODE=cloud_run_job — the local
dispatcher handles dev/test environments.

The agents service account (visualsprint-backend-service-a@...) needs
roles/run.developer on the Cloud Run Job resource to invoke it:
  gcloud run jobs add-iam-policy-binding visualsprint-bot \\
    --region=us-west1 --project=visualsprint-agent \\
    --member="serviceAccount:visualsprint-backend-service-a@visualsprint-agent.iam.gserviceaccount.com" \\
    --role="roles/run.developer"
"""

import httpx
import structlog

log = structlog.get_logger()

_METADATA_TOKEN_URL = (
    "http://metadata.google.internal/computeMetadata/v1/instance"
    "/service-accounts/default/token"
)
_JOBS_API_BASE = "https://run.googleapis.com/v2"


class CloudRunJobDispatcher:
    """Dispatches each BotSession as an independent Cloud Run Job execution.

    in_flight_count() always returns 0 — Cloud Run manages concurrency at the
    job level (see --task-timeout and --max-retries on the job definition).
    The worker sweep still honours bot_max_concurrent as an upper bound on how
    many jobs are *created* in a single sweep pass, not on how many are
    concurrently running in Cloud Run.
    """

    def __init__(self, project: str, region: str, job_name: str) -> None:
        self._project = project
        self._region = region
        self._job_name = job_name
        self._meta_client = httpx.AsyncClient(timeout=5.0)
        self._api_client = httpx.AsyncClient(timeout=30.0)

    def in_flight_count(self) -> int:
        return 0

    async def dispatch(self, bot_session_id: str) -> None:
        token = await self._get_access_token()
        url = (
            f"{_JOBS_API_BASE}/projects/{self._project}"
            f"/locations/{self._region}/jobs/{self._job_name}:run"
        )
        body = {
            "overrides": {
                "containerOverrides": [
                    {
                        "env": [{"name": "VS_BOT_SESSION_ID", "value": bot_session_id}],
                    }
                ],
                "taskCount": 1,
            }
        }
        resp = await self._api_client.post(
            url,
            json=body,
            headers={"Authorization": f"Bearer {token}"},
        )
        resp.raise_for_status()
        execution_name = resp.json().get("name", "(unknown)")
        log.info(
            "bot_dispatch.cloud_run_job_started",
            bot_session_id=bot_session_id,
            execution=execution_name,
        )

    async def _get_access_token(self) -> str:
        resp = await self._meta_client.get(
            _METADATA_TOKEN_URL,
            headers={"Metadata-Flavor": "Google"},
        )
        resp.raise_for_status()
        return resp.json()["access_token"]
