"""Walking-skeleton end-to-end test: Mode D upload -> acquire -> transcribe.

Proves the actual spine (API -> blob store -> Postgres FSM -> stage handlers)
works together against a real Postgres (the docker-compose dev DB, migrated),
without needing live Google/Azure/Groq credentials or torch/speechbrain — a
fake Transcriber is substituted for the real cascade, the same way the
existing capture-adapter tests substitute a fake blob store and HTTP
transport (see tests/capture/fakes.py).

Deliberately stops after the transcribe stage: understand/verify/remember/
propose/report need a real LLM client and are out of scope for what this
test is proving (see docs/PROJECT_PLAN.md § "First sprint").
"""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

import app.orchestrator.worker as worker
from app.db.base import get_sessionmaker
from app.db.models import (
    AudioTrack,
    CaptureSession,
    CaptureState,
    ConsentRecord,
    Meeting,
    Org,
    PipelineJob,
    Utterance,
)
from app.interfaces.transcriber import (
    Lang,
    TranscriptionRequest,
    TranscriptionResult,
    TranscriptSegment,
)
from app.main import app as fastapi_app

FAKE_AUDIO_BYTES = b"RIFF-FAKE-WAV-BYTES-NOT-REAL-AUDIO"


class FakeTranscriber:
    """Returns a fixed, recognizable code-switched result regardless of input —
    proves the segments->Utterance wiring, not real ASR quality."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    async def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult:
        self.calls.append(request.audio_uri)
        return TranscriptionResult(
            segments=[
                TranscriptSegment(
                    start_s=0.0,
                    end_s=2.5,
                    text="API eka deploy panna ready",
                    lang_tags=[Lang.EN, Lang.SI],
                    asr_confidence=0.9,
                    provider="fake:test",
                ),
                TranscriptSegment(
                    start_s=2.5,
                    end_s=5.0,
                    text="authentication issue innum fix agala",
                    lang_tags=[Lang.EN, Lang.SI],
                    asr_confidence=0.85,
                    provider="fake:test",
                ),
            ],
            providers_used=["fake:test"],
        )


@pytest.fixture
def fake_transcriber(monkeypatch):
    fake = FakeTranscriber()
    monkeypatch.setattr(worker, "_transcriber", fake)
    yield fake
    monkeypatch.setattr(worker, "_transcriber", None)


@pytest.fixture
def client():
    return TestClient(fastapi_app)


@pytest.fixture(autouse=True)
def _cleanup_default_org():
    """The upload endpoint auto-creates an org named 'default' when none is
    supplied; drop everything it touches so repeated test runs don't collide
    with leftover rows from a prior run against the same dev database."""
    yield
    Session = get_sessionmaker()
    with Session() as db:
        org = db.query(Org).filter(Org.name == "default").one_or_none()
        if org is not None:
            db.query(Utterance).filter(Utterance.org_id == org.id).delete()
            db.query(PipelineJob).filter(PipelineJob.org_id == org.id).delete()
            db.query(ConsentRecord).filter(ConsentRecord.org_id == org.id).delete()
            db.query(AudioTrack).filter(AudioTrack.org_id == org.id).delete()
            db.query(CaptureSession).filter(CaptureSession.org_id == org.id).delete()
            db.query(Meeting).filter(Meeting.org_id == org.id).delete()
            db.delete(org)
            db.commit()


def test_upload_then_transcribe_produces_utterances(client, fake_transcriber):
    resp = client.post(
        "/api/v1/meetings/upload",
        files={"file": ("standup.wav", FAKE_AUDIO_BYTES, "audio/wav")},
        data={"title": "Sprint Planning"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    session_id = body["capture_session_id"]
    assert body["state"] == CaptureState.SCHEDULED.value

    # Drive the FSM by hand: one claim = one stage. acquire, then transcribe.
    import asyncio

    assert asyncio.run(worker.run_once()) is True  # acquire
    assert asyncio.run(worker.run_once()) is True  # transcribe

    assert fake_transcriber.calls, "transcribe stage never called the Transcriber"

    Session = get_sessionmaker()
    with Session() as db:
        utterances = db.execute(
            select(Utterance)
            .where(Utterance.capture_session_id == session_id)
            .order_by(Utterance.start_s)
        ).scalars().all()

    assert len(utterances) == 2
    assert utterances[0].text == "API eka deploy panna ready"
    assert utterances[0].lang_tags == ["en", "si"]
    assert utterances[0].provider == "fake:test"
    assert utterances[1].text == "authentication issue innum fix agala"

    # State tracks the stage that just ran, not the one queued next — the
    # `understand` job is enqueued but hasn't been claimed by a worker yet.
    status = client.get(f"/api/v1/meetings/sessions/{session_id}")
    assert status.json()["state"] == CaptureState.TRANSCRIBING.value
