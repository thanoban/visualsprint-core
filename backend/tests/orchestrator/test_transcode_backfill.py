"""app/orchestrator/transcode_backfill.py's core sweep logic, against a fake
BlobStore and a monkeypatched transcode_to_flac -- no real ffmpeg needed."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.orchestrator.transcode_backfill as backfill_module
from app.db.base import Base
from app.db.models import AudioTrack, CaptureSession, Meeting, Org
from app.orchestrator.transcode_backfill import backfill_flac_transcodes


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


class FakeBlobStore:
    def __init__(self, *, contents: dict[str, bytes] | None = None) -> None:
        self.contents = contents or {}
        self.deleted: list[str] = []
        self.put_calls: list[tuple[str, bytes]] = []

    async def get(self, uri: str) -> bytes:
        return self.contents[uri]

    async def put(self, key: str, data: bytes, content_type: str = "") -> str:
        self.put_calls.append((key, data))
        return f"blob://{key}"

    async def delete(self, uri: str) -> None:
        self.deleted.append(uri)

    async def exists(self, uri: str) -> bool:
        return uri in self.contents

    async def presigned_url(self, uri: str, expires_s: int = 3600) -> str:
        return uri


def _seed_track(db, *, uri: str) -> AudioTrack:
    org = Org(name="acme")
    db.add(org)
    db.flush()
    meeting = Meeting(
        org_id=org.id, title="Standup", platform="upload", scheduled_start=datetime.now(UTC)
    )
    db.add(meeting)
    db.flush()
    session = CaptureSession(org_id=org.id, meeting_id=meeting.id, mode="D")
    db.add(session)
    db.flush()
    track = AudioTrack(org_id=org.id, capture_session_id=session.id, uri=uri)
    db.add(track)
    db.commit()
    return track


async def test_already_flac_tracks_are_left_alone(db, monkeypatch):
    _seed_track(db, uri="blob://audio/acme/x.flac")
    called = False

    def fake_transcode(raw, suffix):
        nonlocal called
        called = True
        return b"should not be reached"

    monkeypatch.setattr(backfill_module, "transcode_to_flac", fake_transcode)
    blob_store = FakeBlobStore()

    transcoded = await backfill_flac_transcodes(db, blob_store)

    assert transcoded == []
    assert called is False


async def test_non_flac_track_is_retranscoded_when_ffmpeg_now_available(db, monkeypatch):
    track = _seed_track(db, uri="blob://audio/acme/x.wav")
    blob_store = FakeBlobStore(contents={"blob://audio/acme/x.wav": b"raw-wav-bytes"})
    monkeypatch.setattr(backfill_module, "transcode_to_flac", lambda raw, suffix: b"flac-bytes")

    transcoded = await backfill_flac_transcodes(db, blob_store)

    assert transcoded == [track.id]
    assert blob_store.put_calls == [("audio/acme/x.flac", b"flac-bytes")]
    assert blob_store.deleted == ["blob://audio/acme/x.wav"]
    assert track.uri == "blob://audio/acme/x.flac"


async def test_track_is_left_untouched_when_ffmpeg_still_unavailable(db, monkeypatch):
    track = _seed_track(db, uri="blob://audio/acme/x.m4a")
    blob_store = FakeBlobStore(contents={"blob://audio/acme/x.m4a": b"raw-bytes"})
    monkeypatch.setattr(backfill_module, "transcode_to_flac", lambda raw, suffix: None)

    transcoded = await backfill_flac_transcodes(db, blob_store)

    assert transcoded == []
    assert blob_store.put_calls == []
    assert blob_store.deleted == []
    assert track.uri == "blob://audio/acme/x.m4a"


async def test_empty_uri_tracks_from_a_prior_retention_purge_are_skipped(db, monkeypatch):
    _seed_track(db, uri="")
    called = False

    def fake_transcode(raw, suffix):
        nonlocal called
        called = True

    monkeypatch.setattr(backfill_module, "transcode_to_flac", fake_transcode)
    blob_store = FakeBlobStore()

    transcoded = await backfill_flac_transcodes(db, blob_store)

    assert transcoded == []
    assert called is False
