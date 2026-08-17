"""Tests for the Cloud Run Job and local bot dispatchers."""

import asyncio

import httpx
import pytest

from app.adapters.job_dispatcher_cloud_run import CloudRunJobDispatcher
from app.adapters.job_dispatcher_local import LocalJobDispatcher

PROJECT = "test-project"
REGION = "us-central1"
JOB_NAME = "visualsprint-bot"
BOT_SESSION_ID = "bot-session-abc123"

_TOKEN_RESP = {"access_token": "fake-token", "expires_in": 3600, "token_type": "Bearer"}


def _make_transport() -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "metadata.google.internal" in url:
            assert request.headers.get("Metadata-Flavor") == "Google"
            return httpx.Response(200, json=_TOKEN_RESP)
        if f"/jobs/{JOB_NAME}:run" in url:
            assert request.headers.get("authorization") == "Bearer fake-token"
            body = request.read()
            import json

            data = json.loads(body)
            env_overrides = data["overrides"]["containerOverrides"][0]["env"]
            assert any(
                e["name"] == "VS_BOT_SESSION_ID" and e["value"] == BOT_SESSION_ID
                for e in env_overrides
            )
            return httpx.Response(200, json={"name": f"projects/{PROJECT}/locations/{REGION}/jobs/{JOB_NAME}/executions/exec-1"})
        raise AssertionError(f"unexpected request: {request.method} {url}")

    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_cloud_run_dispatcher_calls_jobs_api():
    dispatcher = CloudRunJobDispatcher(project=PROJECT, region=REGION, job_name=JOB_NAME)
    dispatcher._meta_client = httpx.AsyncClient(transport=_make_transport())
    dispatcher._api_client = httpx.AsyncClient(transport=_make_transport())

    await dispatcher.dispatch(BOT_SESSION_ID)


@pytest.mark.asyncio
async def test_cloud_run_dispatcher_in_flight_count_always_zero():
    dispatcher = CloudRunJobDispatcher(project=PROJECT, region=REGION, job_name=JOB_NAME)
    assert dispatcher.in_flight_count() == 0


@pytest.mark.asyncio
async def test_local_dispatcher_tracks_tasks():
    completed = asyncio.Event()

    async def fake_runner(session_id: str) -> None:
        await asyncio.sleep(0)
        completed.set()

    dispatcher = LocalJobDispatcher()

    # Inject the fake runner via the seam in runner module
    import app.adapters.job_dispatcher_local as mod

    original = mod.asyncio.create_task

    tasks_created = []

    def fake_create_task(coro):
        task = original(coro)
        tasks_created.append(task)
        return task

    mod.asyncio.create_task = fake_create_task

    # Patch the run_bot_session import
    import app.bot.runner as runner_mod

    original_runner = getattr(runner_mod, "run_bot_session", None)

    async def _patched(session_id):
        await fake_runner(session_id)

    runner_mod.run_bot_session = _patched
    try:
        await dispatcher.dispatch(BOT_SESSION_ID)
        assert dispatcher.in_flight_count() == 1
        await asyncio.sleep(0.01)
        # After the task completes, in_flight_count drops
        await asyncio.gather(*tasks_created, return_exceptions=True)
        assert dispatcher.in_flight_count() == 0
    finally:
        mod.asyncio.create_task = original
        if original_runner is not None:
            runner_mod.run_bot_session = original_runner
