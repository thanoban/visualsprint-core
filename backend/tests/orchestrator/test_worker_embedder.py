import pytest

import app.orchestrator.worker as worker
from app.db.models import PipelineJob


@pytest.fixture(autouse=True)
def _reset_worker_embedder():
    original = worker._embedder
    worker._embedder = None
    yield
    worker._embedder = original


def test_get_embedder_degrades_and_caches_unavailable_state(monkeypatch):
    calls = 0

    def unavailable():
        nonlocal calls
        calls += 1
        raise RuntimeError("ADC not configured")

    monkeypatch.setattr(worker, "_build_embedder", unavailable)

    assert worker._get_embedder() is None
    assert worker._get_embedder() is None
    assert calls == 1


async def test_remember_stage_degrades_to_keyword_memory_when_embedder_unavailable(monkeypatch):
    captured = {}

    def unavailable():
        raise RuntimeError("ADC not configured")

    async def fake_run_memory_intelligence(db, capture_session_id, llm, model=None, embedder=None):
        captured["db"] = db
        captured["capture_session_id"] = capture_session_id
        captured["llm"] = llm
        captured["embedder"] = embedder
        return ["processed"]

    monkeypatch.setattr(worker, "_build_embedder", unavailable)
    monkeypatch.setattr(worker, "_llm_client", object())

    import app.agents.memory as memory

    monkeypatch.setattr(memory, "run_memory_intelligence", fake_run_memory_intelligence)

    job = PipelineJob(org_id="org-1", capture_session_id="session-1", stage="remember")
    db = object()

    await worker._handle_remember(db, job)

    assert captured == {
        "db": db,
        "capture_session_id": "session-1",
        "llm": worker._llm_client,
        "embedder": None,
    }
