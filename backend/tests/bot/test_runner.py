"""Mode B bot-join capture end to end (app/bot/runner.py). Fakes every
browser-touching piece (MeetingJoiner, PlaywrightAudioCapture,
PlaywrightScreenCapture) so this never launches a real headless Chromium --
same seam convention as worker._transcriber/_diarizer for the rest of the
pipeline. Runs against an in-memory SQLite bound into
app.bot.runner.get_sessionmaker, mirroring the pattern other orchestrator
tests use for the real Postgres-backed get_sessionmaker.
"""

from pathlib import Path

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.bot.runner as runner
from app.db.base import Base
from app.db.models import (
    AudioTrack,
    BotSession,
    BotStatus,
    CaptureSession,
    Meeting,
    Org,
    Participant,
    PipelineJob,
)
from app.interfaces.meeting_bot import BotRosterEntry, JoinOutcome

REAL_WEBM_CHUNKS_TO_WAV = runner._webm_chunks_to_wav


@pytest.fixture
def db_sessionmaker(monkeypatch):
    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(runner, "get_sessionmaker", lambda: Session)
    yield Session
    engine.dispose()


@pytest.fixture(autouse=True)
def _fast_timeouts(monkeypatch):
    """Real timeouts (10min lobby, 5s poll) would make this suite glacial --
    shrink to values a test can actually wait out."""
    monkeypatch.setattr(runner, "LOBBY_TIMEOUT_S", 0.05)
    monkeypatch.setattr(runner, "_LOBBY_POLL_INTERVAL_S", 0.01)
    monkeypatch.setattr(runner, "_POLL_INTERVAL_S", 0.01)
    monkeypatch.setattr(runner, "MAX_MEETING_S", 1.0)


class FakeBlobStore:
    def __init__(self) -> None:
        self.puts: list[tuple[str, bytes, str]] = []

    async def put(self, key, data, content_type="application/octet-stream"):
        self.puts.append((key, data, content_type))
        return f"blob://{key}"

    async def get(self, uri):
        raise NotImplementedError

    async def exists(self, uri):
        return True

    async def delete(self, uri):
        return None

    async def presigned_url(self, uri, expires_s=3600):
        return uri


@pytest.fixture(autouse=True)
def fake_blobstore(monkeypatch):
    store = FakeBlobStore()
    monkeypatch.setattr("app.adapters.blobstore_s3.get_blobstore", lambda: store)
    return store


class FakeJoiner:
    """Configurable MeetingJoiner: `outcomes` is consumed one at a time by
    poll_status() after the first join() call establishes initial state."""

    platform = "meet"

    def __init__(self, *, join_outcome, poll_outcomes=(), roster=None):
        self.page = object()
        self._join_outcome = join_outcome
        self._poll_outcomes = list(poll_outcomes)
        self._roster = roster or []
        self.left = False
        self.join_calls = 0
        self.warning_detail = None

    async def join(self, join_url, *, display_name="VisualSprint Notetaker"):
        self.join_calls += 1
        return self._join_outcome

    async def poll_status(self):
        if self._poll_outcomes:
            return self._poll_outcomes.pop(0)
        return self._join_outcome  # keep reporting the last known state once outcomes run out

    async def roster(self):
        return self._roster

    async def leave(self):
        self.left = True


class FakeAudioCapture:
    def __init__(self, page) -> None:
        self.started = False
        self.stopped = False

    async def start(self):
        self.started = True

    async def chunks(self):
        yield type("Chunk", (), {"seq": 1, "data": b"fake-audio-bytes", "captured_at_s": 0.0})()

    async def stop(self):
        self.stopped = True
        return b""


class FakeScreenCapture:
    def __init__(self, page) -> None:
        self.started = False
        self.stopped = False

    async def start(self):
        self.started = True

    async def frames(self):
        return
        yield  # pragma: no cover -- makes this an async generator with zero items

    async def stop(self):
        self.stopped = True


class ScreenFrameCapture(FakeScreenCapture):
    async def frames(self):
        yield type("Frame", (), {"captured_at_s": 0.0, "image_bytes": b"frame-one"})()
        yield type("Frame", (), {"captured_at_s": 1.0, "image_bytes": b"frame-two"})()


@pytest.fixture(autouse=True)
def fake_capture_classes(monkeypatch):
    monkeypatch.setattr("app.bot.audio_capture.PlaywrightAudioCapture", FakeAudioCapture)
    monkeypatch.setattr("app.bot.screen_capture.PlaywrightScreenCapture", FakeScreenCapture)
    # Browser bytes are deliberately synthetic in this suite. Conversion is
    # exercised separately from bot lifecycle behavior, so keep the lifecycle
    # tests independent from a host ffmpeg installation.
    monkeypatch.setattr(runner, "_webm_chunks_to_wav", lambda chunks: b"fake-wav" if chunks else None)


def _seed_bot_session(db_sessionmaker, *, platform="meet") -> str:
    with db_sessionmaker() as db:
        org = Org(name="Acme")
        db.add(org)
        db.flush()
        meeting = Meeting(org_id=org.id, platform=platform, title="Standup")
        db.add(meeting)
        db.flush()
        bot = BotSession(
            org_id=org.id,
            meeting_id=meeting.id,
            platform=platform,
            join_url="https://meet.google.com/abc-defg-hij",
            status=BotStatus.SCHEDULED,
        )
        db.add(bot)
        db.commit()
        return bot.id


async def test_live_join_captures_audio_and_finalizes_capture_session(db_sessionmaker, monkeypatch):
    bot_id = _seed_bot_session(db_sessionmaker)
    joiner = FakeJoiner(
        join_outcome=JoinOutcome.LIVE,
        poll_outcomes=[JoinOutcome.ENDED],
        roster=[BotRosterEntry(display_name="Nimal")],
    )
    monkeypatch.setattr(runner, "_joiner_factories", {"meet": lambda: joiner})

    await runner.run_bot_session(bot_id)

    with db_sessionmaker() as db:
        bot = db.get(BotSession, bot_id)
        assert bot.status == BotStatus.ENDED
        assert bot.audio_blob_uri is not None
        assert bot.capture_session_id is not None

        session = db.get(CaptureSession, bot.capture_session_id)
        assert session.mode == "B"

        tracks = db.execute(
            select(AudioTrack).where(AudioTrack.capture_session_id == session.id)
        ).scalars().all()
        assert len(tracks) == 1
        assert tracks[0].uri == bot.audio_blob_uri

        participants = db.execute(
            select(Participant).where(Participant.capture_session_id == session.id)
        ).scalars().all()
        assert [p.display_name for p in participants] == ["Nimal"]

        job = db.execute(
            select(PipelineJob).where(PipelineJob.capture_session_id == session.id)
        ).scalar_one()
        assert job.stage == "acquire"

    assert joiner.left is True


async def test_lobby_timeout_never_admitted_is_not_a_hang(db_sessionmaker, monkeypatch):
    bot_id = _seed_bot_session(db_sessionmaker, platform="teams")
    joiner = FakeJoiner(join_outcome=JoinOutcome.IN_LOBBY, poll_outcomes=[])  # always stays in lobby
    monkeypatch.setattr(runner, "_joiner_factories", {"teams": lambda: joiner})

    await runner.run_bot_session(bot_id)

    with db_sessionmaker() as db:
        bot = db.get(BotSession, bot_id)
        assert bot.status == BotStatus.LOBBY_TIMEOUT
        assert bot.lobby_timeout_at is not None
        assert bot.capture_session_id is None
        assert db.query(CaptureSession).count() == 0

    assert joiner.left is True


async def test_denied_join_marks_failed_without_capturing(db_sessionmaker, monkeypatch):
    bot_id = _seed_bot_session(db_sessionmaker)
    joiner = FakeJoiner(join_outcome=JoinOutcome.DENIED)
    monkeypatch.setattr(runner, "_joiner_factories", {"meet": lambda: joiner})

    await runner.run_bot_session(bot_id)

    with db_sessionmaker() as db:
        bot = db.get(BotSession, bot_id)
        assert bot.status == BotStatus.FAILED
        assert bot.capture_session_id is None
        assert "cannot bypass" in bot.error


async def test_denied_join_preserves_google_session_warning(db_sessionmaker, monkeypatch):
    bot_id = _seed_bot_session(db_sessionmaker)
    joiner = FakeJoiner(join_outcome=JoinOutcome.DENIED)
    joiner.warning_detail = "The stored Google bot session expired before join."
    monkeypatch.setattr(runner, "_joiner_factories", {"meet": lambda: joiner})

    await runner.run_bot_session(bot_id)

    with db_sessionmaker() as db:
        bot = db.get(BotSession, bot_id)
        assert bot.status == BotStatus.FAILED
        assert bot.error.startswith("The stored Google bot session expired before join.")
        assert "Also: The organizer denied the Google Meet lobby request" in bot.error


async def test_smoke_capture_cap_finalizes_without_waiting_for_meeting_end(
    db_sessionmaker, monkeypatch
):
    settings = type(
        "Settings",
        (),
        {
            "bot_lobby_timeout_s": None,
            "bot_max_meeting_s": None,
            "bot_smoke_capture_seconds": 0.02,
        },
    )()
    monkeypatch.setattr(runner, "get_settings", lambda: settings)

    bot_id = _seed_bot_session(db_sessionmaker)
    joiner = FakeJoiner(join_outcome=JoinOutcome.LIVE, poll_outcomes=[])
    monkeypatch.setattr(runner, "_joiner_factories", {"meet": lambda: joiner})

    await runner.run_bot_session(bot_id)

    with db_sessionmaker() as db:
        bot = db.get(BotSession, bot_id)
        assert bot.status == BotStatus.ENDED
        assert bot.capture_session_id is not None


async def test_lobby_then_admitted_transitions_to_live_and_captures(db_sessionmaker, monkeypatch):
    bot_id = _seed_bot_session(db_sessionmaker)
    joiner = FakeJoiner(
        join_outcome=JoinOutcome.IN_LOBBY,
        poll_outcomes=[JoinOutcome.LIVE, JoinOutcome.ENDED],
    )
    monkeypatch.setattr(runner, "_joiner_factories", {"meet": lambda: joiner})

    await runner.run_bot_session(bot_id)

    with db_sessionmaker() as db:
        bot = db.get(BotSession, bot_id)
        assert bot.status == BotStatus.ENDED
        assert bot.capture_session_id is not None


async def test_no_audio_captured_marks_failed(db_sessionmaker, monkeypatch):
    """An empty meeting (or a capture pipeline that silently produced
    nothing) must surface as an honest failure, not a phantom empty
    CaptureSession downstream stages would choke on."""

    class SilentAudioCapture(FakeAudioCapture):
        async def chunks(self):
            return
            yield  # pragma: no cover

    monkeypatch.setattr("app.bot.audio_capture.PlaywrightAudioCapture", SilentAudioCapture)

    bot_id = _seed_bot_session(db_sessionmaker)
    joiner = FakeJoiner(join_outcome=JoinOutcome.LIVE, poll_outcomes=[JoinOutcome.ENDED])
    monkeypatch.setattr(runner, "_joiner_factories", {"meet": lambda: joiner})

    await runner.run_bot_session(bot_id)

    with db_sessionmaker() as db:
        bot = db.get(BotSession, bot_id)
        assert bot.status == BotStatus.FAILED
        assert "no audio" in bot.error
        assert bot.capture_session_id is None


async def test_live_join_with_screen_frames_uploads_keyframes(db_sessionmaker, monkeypatch):
    monkeypatch.setattr("app.bot.screen_capture.PlaywrightScreenCapture", ScreenFrameCapture)
    monkeypatch.setattr(runner, "SCREEN_MIN_KEEP_INTERVAL_S", 0.0)

    bot_id = _seed_bot_session(db_sessionmaker)
    joiner = FakeJoiner(join_outcome=JoinOutcome.LIVE, poll_outcomes=[JoinOutcome.ENDED])
    monkeypatch.setattr(runner, "_joiner_factories", {"meet": lambda: joiner})

    await runner.run_bot_session(bot_id)

    with db_sessionmaker() as db:
        from sqlalchemy import select

        from app.db.models import Keyframe

        bot = db.get(BotSession, bot_id)
        session = db.get(CaptureSession, bot.capture_session_id)
        assert session is not None
        assert session.video_uri is None  # no mp4 mux — keyframes uploaded directly
        keyframes = db.execute(
            select(Keyframe).where(Keyframe.capture_session_id == session.id)
        ).scalars().all()
        assert len(keyframes) > 0  # pre-extracted frames persisted as Keyframe rows
        assert all(kf.image_uri.startswith("blob://keyframes/") for kf in keyframes)
        assert [kf.valid_from_s for kf in keyframes] == [0.0, 1.0]


def test_webm_chunks_are_given_to_ffmpeg_as_a_concat_manifest(monkeypatch):
    """Independent MediaRecorder fragments cannot safely be byte-joined."""
    calls = []

    def fake_run(command, **kwargs):
        calls.append((command, kwargs))
        manifest_path = command[command.index("-i") + 1]
        manifest = Path(manifest_path).read_text(encoding="utf-8")
        assert "ffconcat version 1.0" in manifest
        assert "chunk000000.webm" in manifest
        assert "chunk000001.webm" in manifest
        return type("Completed", (), {"returncode": 0, "stdout": b"wav", "stderr": b""})()

    monkeypatch.setattr(runner.shutil, "which", lambda name: "ffmpeg")
    monkeypatch.setattr(runner.subprocess, "run", fake_run)

    assert REAL_WEBM_CHUNKS_TO_WAV([b"first", b"second"]) == b"wav"
    command, kwargs = calls[0]
    assert command[2:5] == ["-f", "concat", "-safe"]
    assert "input" not in kwargs
