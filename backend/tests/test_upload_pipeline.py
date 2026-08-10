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
    Correction,
    CoverageInterval,
    GlossaryTerm,
    Keyframe,
    Meeting,
    Org,
    Participant,
    PipelineJob,
    User,
    Utterance,
    UtteranceKeyframe,
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


@pytest.fixture(autouse=True)
def _reset_screen_captioner(monkeypatch):
    monkeypatch.setattr(worker, "_vlm_captioner", worker._VLM_CAPTIONER_UNAVAILABLE)
    # _llm_client is a lazy module-global singleton (worker._get_llm) -- once
    # any test reaches it without an explicit monkeypatch override, it
    # permanently caches a real VertexLlmClient for the rest of the suite
    # run whenever real Vertex credentials are present in the environment
    # (backend/.env), silently leaking into later tests that never intended
    # to make a live call. Reset it alongside the captioner so test order
    # never matters here.
    monkeypatch.setattr(worker, "_llm_client", None)


@pytest.fixture
def default_org_id():
    Session = get_sessionmaker()
    with Session() as db:
        org = db.query(Org).filter(Org.name == "default").one_or_none()
        if org is None:
            org = Org(name="default")
            db.add(org)
            db.commit()
        return org.id


@pytest.fixture
def client(monkeypatch):
    """Overrides auth the same way tests/api/conftest.py does -- a fixed
    fake user plus is_org_member always True -- since org_id is now a
    required Form field (app/api/upload.py), not an auto-created "default"
    convenience. See that conftest's docstring for why is_org_member is
    monkeypatched on the module rather than via dependency_overrides."""
    import app.auth.dependency as auth_dep

    fake_user = User(id="test-user-0000-0000-0000-000000000000", email="test@example.com")
    monkeypatch.setattr(auth_dep, "is_org_member", lambda db, org_id, user: True)
    fastapi_app.dependency_overrides[auth_dep.get_current_user] = lambda: fake_user
    try:
        yield TestClient(fastapi_app)
    finally:
        fastapi_app.dependency_overrides.clear()


def _delete_default_org_children(db) -> None:
    org = db.query(Org).filter(Org.name == "default").one_or_none()
    if org is None:
        return
    # GlossaryTerm.source_correction_id -> Correction.id -> Utterance.id, so
    # both must go before Utterance is deleted (app/api/corrections.py).
    db.query(GlossaryTerm).filter(GlossaryTerm.org_id == org.id).delete()
    db.query(Correction).filter(Correction.org_id == org.id).delete()
    db.query(UtteranceKeyframe).filter(UtteranceKeyframe.org_id == org.id).delete()
    db.query(Keyframe).filter(Keyframe.org_id == org.id).delete()
    db.query(Utterance).filter(Utterance.org_id == org.id).delete()
    db.query(Participant).filter(Participant.org_id == org.id).delete()
    db.query(PipelineJob).filter(PipelineJob.org_id == org.id).delete()
    db.query(ConsentRecord).filter(ConsentRecord.org_id == org.id).delete()
    db.query(CoverageInterval).filter(CoverageInterval.org_id == org.id).delete()
    db.query(AudioTrack).filter(AudioTrack.org_id == org.id).delete()
    db.query(CaptureSession).filter(CaptureSession.org_id == org.id).delete()
    db.query(Meeting).filter(Meeting.org_id == org.id).delete()
    db.delete(org)
    db.commit()


def _cleanup_with_retry() -> None:
    """Retries once on a transient DB error: this test suite runs many
    short-lived sessions in quick succession against a live shared dev
    Postgres (client requests, worker.run_once() calls, this cleanup), and
    an occasional connection/lock timing race is a known class of flaky-
    integration-test class, not evidence of a product bug -- the pipeline
    code itself has zero flakiness across repeated runs."""
    Session = get_sessionmaker()
    try:
        with Session() as db:
            _delete_default_org_children(db)
    except Exception as exc:
        import time

        time.sleep(0.3)
        with Session() as db:
            db.rollback()
            try:
                _delete_default_org_children(db)
            except Exception:
                raise exc from None


@pytest.fixture(autouse=True)
def _cleanup_default_org():
    """The upload endpoint auto-creates an org named 'default' when none is
    supplied; drop everything it touches so repeated test runs don't collide
    with leftover rows from a prior run against the same dev database.

    Cleans up BEFORE as well as after each test. Teardown-only cleanup has a
    real failure mode: if one pytest invocation's teardown itself errors
    (see _cleanup_with_retry's docstring) before it can delete stray
    `pipeline_job` rows, the NEXT invocation's worker.run_once() calls claim
    jobs from the FIFO-ordered global queue without regard to which test
    created them -- a stale job from a completely different, already-torn-
    down session gets processed by a test that never intended to reach that
    stage (observed: a test that only drives acquire+transcribe landed on a
    stray `understand` job and hit a live Vertex AI call). Belt-and-
    suspenders: clean at setup so a prior run's failure can never poison the
    next one, not just at teardown for a clean run's own sake."""
    _cleanup_with_retry()
    yield
    _cleanup_with_retry()


def test_upload_then_transcribe_produces_utterances(client, default_org_id, fake_transcriber):
    resp = client.post(
        "/api/v1/meetings/upload",
        files={"file": ("standup.wav", FAKE_AUDIO_BYTES, "audio/wav")},
        data={"title": "Sprint Planning", "org_id": default_org_id},
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
        utterances = (
            db.execute(
                select(Utterance)
                .where(Utterance.capture_session_id == session_id)
                .order_by(Utterance.start_s)
            )
            .scalars()
            .all()
        )

    assert len(utterances) == 2
    assert utterances[0].text == "API eka deploy panna ready"
    assert utterances[0].lang_tags == ["en", "si"]
    assert utterances[0].provider == "fake:test"
    assert utterances[1].text == "authentication issue innum fix agala"

    # No participant roster / OCR context exists for this session, so the
    # LLM repair pass short-circuits (app.asr.repair) rather than requiring
    # live Vertex AI credentials — repaired stays False, not silently True.
    assert all(u.repaired is False for u in utterances)

    # State tracks the stage that just ran, not the one queued next — the
    # `understand` job is enqueued but hasn't been claimed by a worker yet.
    status = client.get(f"/api/v1/meetings/sessions/{session_id}")
    assert status.json()["state"] == CaptureState.TRANSCRIBING.value


def test_transcribe_writes_coverage_gap_for_failed_segment(client, default_org_id, monkeypatch):
    """CLAUDE.md rule 6, proven through the real transcribe stage handler
    (not just app.asr.coverage's unit tests): a span the cascade couldn't
    transcribe becomes a first-class CoverageInterval row, not just a
    quietly-low-confidence Utterance indistinguishable from a mumbled word."""
    from app.db.models import CoverageInterval, CoverageStatus

    class PartiallyFailingTranscriber:
        def __init__(self) -> None:
            self.calls: list[str] = []

        async def transcribe(self, request):
            self.calls.append(request.audio_uri)
            return TranscriptionResult(
                segments=[
                    TranscriptSegment(
                        start_s=0.0,
                        end_s=2.0,
                        text="deploy eka ready",
                        lang_tags=[Lang.EN, Lang.SI],
                        asr_confidence=0.9,
                        provider="fake:test",
                    ),
                    TranscriptSegment(
                        start_s=2.0,
                        end_s=4.0,
                        text="",  # nothing transcribed for this span
                        lang_tags=[Lang.UNKNOWN],
                        asr_confidence=0.0,
                        provider="unrouted",
                    ),
                ],
                providers_used=["fake:test", "unrouted"],
            )

    fake = PartiallyFailingTranscriber()
    monkeypatch.setattr(worker, "_transcriber", fake)

    resp = client.post(
        "/api/v1/meetings/upload",
        files={"file": ("standup.wav", FAKE_AUDIO_BYTES, "audio/wav")},
        data={"title": "Partial capture failure", "org_id": default_org_id},
    )
    assert resp.status_code == 200, resp.text
    session_id = resp.json()["capture_session_id"]

    import asyncio

    assert asyncio.run(worker.run_once()) is True  # acquire
    assert asyncio.run(worker.run_once()) is True  # transcribe
    assert fake.calls

    Session = get_sessionmaker()
    with Session() as db:
        gaps = (
            db.execute(
                select(CoverageInterval).where(CoverageInterval.capture_session_id == session_id)
            )
            .scalars()
            .all()
        )

    assert len(gaps) == 1
    assert gaps[0].status == CoverageStatus.MISSING
    assert gaps[0].modality == "audio"
    assert gaps[0].start_s == 2.0
    assert gaps[0].end_s == 4.0
    assert "unrouted" in gaps[0].reason


def test_transcribe_applies_llm_repair_when_context_exists(client, default_org_id, fake_transcriber, monkeypatch):
    """With a participant roster present, the transcribe stage must actually
    call through app.asr.repair and persist the repaired text with
    repaired=True — proving worker.py's wiring, not just repair_segments in
    isolation (already covered by tests/asr/test_repair.py)."""
    from app.interfaces.llm import LlmUsage

    class FakeLlm:
        async def complete_structured(
            self, *, model, system, user_content, schema, max_tokens=4096
        ):
            from app.asr.repair import RepairResult

            return (
                RepairResult(
                    segments=[
                        {"index": 0, "text": "API eka deploy panna ready — REPAIRED"},
                        {"index": 1, "text": "authentication issue innum fix agala"},
                    ]
                ),
                LlmUsage(input_tokens=1, output_tokens=1, model=model),
            )

    monkeypatch.setattr(worker, "_llm_client", FakeLlm())

    resp = client.post(
        "/api/v1/meetings/upload",
        files={"file": ("standup2.wav", FAKE_AUDIO_BYTES, "audio/wav")},
        data={"title": "Sprint Planning 2", "org_id": default_org_id},
    )
    assert resp.status_code == 200, resp.text
    session_id = resp.json()["capture_session_id"]

    Session = get_sessionmaker()
    with Session() as db:
        session = db.get(CaptureSession, session_id)
        db.add(
            Participant(org_id=session.org_id, capture_session_id=session_id, display_name="Kasun")
        )
        db.commit()

    import asyncio

    assert asyncio.run(worker.run_once()) is True  # acquire
    assert asyncio.run(worker.run_once()) is True  # transcribe

    with Session() as db:
        utterances = (
            db.execute(
                select(Utterance)
                .where(Utterance.capture_session_id == session_id)
                .order_by(Utterance.start_s)
            )
            .scalars()
            .all()
        )

    assert utterances[0].text == "API eka deploy panna ready — REPAIRED"
    assert utterances[0].repaired is True
    assert utterances[1].text == "authentication issue innum fix agala"
    assert utterances[1].repaired is False  # unchanged text -> not flagged as repaired


def test_video_upload_produces_keyframes_and_grounding(client, default_org_id, fake_transcriber, monkeypatch):
    """A video-format Mode D upload doubles as the screen source (see
    api/upload.py) -- proves acquire -> transcribe -> screen wires keyframe
    detection, OCR, and speech<->screen grounding together end-to-end, using
    fakes for opencv/PaddleOCR so this needs neither installed."""
    from app.screen.keyframe_detect import KeyframeCandidate

    class FakeKeyframeDetector:
        def __call__(self, video_path: str) -> list[KeyframeCandidate]:
            # Spans both fake-transcriber utterances (0.0-2.5s, 2.5-5.0s) so
            # temporal grounding has something to link.
            return [
                KeyframeCandidate(
                    valid_from_s=0.0,
                    valid_to_s=5.0,
                    image_bytes=b"\xff\xd8fake-jpeg",
                    phash="abc123",
                )
            ]

    class FakeOcrResult:
        full_text = "Ticket PAY-442 blocking the release"
        blocks = []

    class FakeOcr:
        async def recognize(self, image_uri: str) -> FakeOcrResult:
            return FakeOcrResult()

    monkeypatch.setattr(worker, "_keyframe_detect_fn", FakeKeyframeDetector())
    monkeypatch.setattr(worker, "_ocr_engine", FakeOcr())

    resp = client.post(
        "/api/v1/meetings/upload",
        files={"file": ("standup3.mp4", FAKE_AUDIO_BYTES, "video/mp4")},
        data={"title": "Sprint Planning 3", "org_id": default_org_id},
    )
    assert resp.status_code == 200, resp.text
    session_id = resp.json()["capture_session_id"]

    Session = get_sessionmaker()
    with Session() as db:
        session = db.get(CaptureSession, session_id)
        assert session.video_uri is not None, "video-format upload must set video_uri"

    import asyncio

    assert asyncio.run(worker.run_once()) is True  # acquire
    assert asyncio.run(worker.run_once()) is True  # transcribe
    assert asyncio.run(worker.run_once()) is True  # screen

    with Session() as db:
        keyframes = (
            db.execute(select(Keyframe).where(Keyframe.capture_session_id == session_id))
            .scalars()
            .all()
        )
        groundings = (
            db.execute(
                select(UtteranceKeyframe).where(
                    UtteranceKeyframe.keyframe_id.in_([k.id for k in keyframes])
                )
            )
            .scalars()
            .all()
        )

    assert len(keyframes) == 1
    kf = keyframes[0]
    assert kf.ocr_text == "Ticket PAY-442 blocking the release"
    assert kf.phash == "abc123"
    assert any(e["text"] == "PAY-442" for e in kf.detected_entities)
    assert kf.vlm_caption == ""  # no captioner configured: honest optional blank

    # Both utterances temporally overlap the one keyframe -> both grounded.
    assert len(groundings) == 2
    assert {g.method for g in groundings} <= {"temporal", "lexical", "both"}

    status = client.get(f"/api/v1/meetings/sessions/{session_id}")
    assert status.json()["state"] == CaptureState.PROCESSING_SCREEN.value


def test_video_upload_persists_vlm_caption_when_captioner_is_configured(
    client, default_org_id, fake_transcriber, monkeypatch
):
    from app.screen.keyframe_detect import KeyframeCandidate

    class FakeKeyframeDetector:
        def __call__(self, video_path: str) -> list[KeyframeCandidate]:
            return [
                KeyframeCandidate(
                    valid_from_s=0.0,
                    valid_to_s=5.0,
                    image_bytes=b"\xff\xd8fake-jpeg",
                    phash="captioned",
                )
            ]

    class FakeOcrResult:
        full_text = "Sprint board"
        blocks = []

    class FakeOcr:
        async def recognize(self, image_uri: str) -> FakeOcrResult:
            return FakeOcrResult()

    class FakeCaptioner:
        def __init__(self) -> None:
            self.calls: list[bytes] = []

        async def caption(self, image_bytes: bytes) -> str:
            self.calls.append(image_bytes)
            return "A sprint board with release tasks."

    captioner = FakeCaptioner()
    monkeypatch.setattr(worker, "_keyframe_detect_fn", FakeKeyframeDetector())
    monkeypatch.setattr(worker, "_ocr_engine", FakeOcr())
    monkeypatch.setattr(worker, "_vlm_captioner", captioner)

    resp = client.post(
        "/api/v1/meetings/upload",
        files={"file": ("captioned.mp4", FAKE_AUDIO_BYTES, "video/mp4")},
        data={"title": "Captioned screen", "org_id": default_org_id},
    )
    assert resp.status_code == 200, resp.text
    session_id = resp.json()["capture_session_id"]

    import asyncio

    assert asyncio.run(worker.run_once()) is True
    assert asyncio.run(worker.run_once()) is True
    assert asyncio.run(worker.run_once()) is True

    Session = get_sessionmaker()
    with Session() as db:
        keyframe = db.execute(
            select(Keyframe).where(Keyframe.capture_session_id == session_id)
        ).scalar_one()

    assert captioner.calls == [b"\xff\xd8fake-jpeg"]
    assert keyframe.vlm_caption == "A sprint board with release tasks."


def test_video_upload_keeps_keyframe_when_vlm_captioning_fails(
    client, default_org_id, fake_transcriber, monkeypatch
):
    from app.screen.keyframe_detect import KeyframeCandidate

    class FakeKeyframeDetector:
        def __call__(self, video_path: str) -> list[KeyframeCandidate]:
            return [
                KeyframeCandidate(
                    valid_from_s=0.0,
                    valid_to_s=5.0,
                    image_bytes=b"\xff\xd8fake-jpeg",
                    phash="caption-failed",
                )
            ]

    class FakeOcrResult:
        full_text = "Ticket PAY-442"
        blocks = []

    class FakeOcr:
        async def recognize(self, image_uri: str) -> FakeOcrResult:
            return FakeOcrResult()

    class FailingCaptioner:
        async def caption(self, image_bytes: bytes) -> str:
            raise RuntimeError("vision model unavailable")

    monkeypatch.setattr(worker, "_keyframe_detect_fn", FakeKeyframeDetector())
    monkeypatch.setattr(worker, "_ocr_engine", FakeOcr())
    monkeypatch.setattr(worker, "_vlm_captioner", FailingCaptioner())

    resp = client.post(
        "/api/v1/meetings/upload",
        files={"file": ("caption-fail.mp4", FAKE_AUDIO_BYTES, "video/mp4")},
        data={"title": "Caption failure", "org_id": default_org_id},
    )
    assert resp.status_code == 200, resp.text
    session_id = resp.json()["capture_session_id"]

    import asyncio

    assert asyncio.run(worker.run_once()) is True
    assert asyncio.run(worker.run_once()) is True
    assert asyncio.run(worker.run_once()) is True

    Session = get_sessionmaker()
    with Session() as db:
        keyframe = db.execute(
            select(Keyframe).where(Keyframe.capture_session_id == session_id)
        ).scalar_one()

    assert keyframe.ocr_text == "Ticket PAY-442"
    assert keyframe.vlm_caption == ""


def test_audio_only_upload_skips_screen_stage_without_failing(client, default_org_id, fake_transcriber):
    """No video_uri (plain .wav upload) is a normal outcome, not a failure --
    the screen stage must complete cleanly with zero keyframes."""
    resp = client.post(
        "/api/v1/meetings/upload",
        files={"file": ("audio-only.wav", FAKE_AUDIO_BYTES, "audio/wav")},
        data={"title": "Audio-only meeting", "org_id": default_org_id},
    )
    session_id = resp.json()["capture_session_id"]

    import asyncio

    assert asyncio.run(worker.run_once()) is True  # acquire
    assert asyncio.run(worker.run_once()) is True  # transcribe
    assert asyncio.run(worker.run_once()) is True  # screen -- must not raise

    Session = get_sessionmaker()
    with Session() as db:
        keyframes = (
            db.execute(select(Keyframe).where(Keyframe.capture_session_id == session_id))
            .scalars()
            .all()
        )
    assert keyframes == []

    status = client.get(f"/api/v1/meetings/sessions/{session_id}")
    assert status.json()["state"] == CaptureState.PROCESSING_SCREEN.value
