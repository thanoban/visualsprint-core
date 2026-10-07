import pytest

from app.capture import worker


@pytest.mark.asyncio
async def test_bounded_pass_drains_both_queues_and_stops_when_empty(monkeypatch):
    dispatch_results = iter([True, True, False])
    reconcile_results = iter([True, False, False])
    calls = []

    async def dispatch(*args, **kwargs):
        calls.append(("dispatch", kwargs["worker_id"]))
        return next(dispatch_results)

    async def reconcile(*args, **kwargs):
        calls.append(("reconcile", kwargs["worker_id"]))
        return next(reconcile_results)

    async def ingest(*args, **kwargs):
        return False

    monkeypatch.setattr(worker, "dispatch_next", dispatch)
    monkeypatch.setattr(worker, "reconcile_next", reconcile)
    monkeypatch.setattr(worker, "ingest_next", ingest)
    result = await worker.run_capture_pass(
        session_factory=lambda: None,
        secret_store=object(),
        worker_id="worker-a",
        max_events=10,
    )
    assert result == {"dispatch_events": 2, "reconcile_events": 1, "ingest_events": 0}
    assert calls == [
        ("dispatch", "worker-a"),
        ("reconcile", "worker-a"),
        ("dispatch", "worker-a"),
        ("reconcile", "worker-a"),
        ("dispatch", "worker-a"),
        ("reconcile", "worker-a"),
    ]


@pytest.mark.asyncio
async def test_pass_obeys_event_bound_even_while_work_remains(monkeypatch):
    async def always(*args, **kwargs):
        return True

    monkeypatch.setattr(worker, "dispatch_next", always)
    monkeypatch.setattr(worker, "reconcile_next", always)
    monkeypatch.setattr(worker, "ingest_next", always)
    result = await worker.run_capture_pass(
        session_factory=lambda: None,
        secret_store=object(),
        max_events=3,
    )
    assert result == {"dispatch_events": 3, "reconcile_events": 3, "ingest_events": 3}


@pytest.mark.asyncio
async def test_pass_rejects_unbounded_configuration():
    with pytest.raises(ValueError, match="max_events"):
        await worker.run_capture_pass(max_events=0)
