"""Worker-level periodic transcode-backfill sweep (worker.py's
_run_transcode_backfill). transcode_backfill.py's own sweep logic is
covered by tests/orchestrator/test_transcode_backfill.py -- this proves the
periodic *caller* worker.py adds: it plugs into the real blobstore factory,
commits on success, and one bad blob doesn't crash the worker loop."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.orchestrator.worker as worker
from app.db.base import Base
from app.db.models import AudioTrack, CaptureSession, Meeting, Org


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
    def __init__(self, *, raises: bool = False) -> None:
        self.raises = raises

    async def get(self, uri: str) -> bytes:
        if self.raises:
            raise RuntimeError("blob store unreachable")
        return b"raw-bytes"

    async def put(self, key: str, data: bytes, content_type: str = "") -> str:
        return f"blob://{key}"

    async def delete(self, uri: str) -> None:
        pass


def _seed_non_flac_track(db) -> AudioTrack:
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
    track = AudioTrack(org_id=org.id, capture_session_id=session.id, uri="blob://audio/acme/x.wav")
    db.add(track)
    db.commit()
    return track


async def test_a_successful_backfill_updates_the_track_and_commits(db, monkeypatch):
    track = _seed_non_flac_track(db)
    blob_store = FakeBlobStore()

    import app.adapters.blobstore_s3 as blobstore_s3

    monkeypatch.setattr(blobstore_s3, "get_blobstore", lambda: blob_store)
    monkeypatch.setattr(
        "app.orchestrator.transcode_backfill.transcode_to_flac", lambda raw, suffix: b"flac-bytes"
    )

    await worker._run_transcode_backfill(db)

    refreshed = db.get(AudioTrack, track.id)
    assert refreshed.uri == "blob://audio/acme/x.flac"


async def test_a_blob_store_failure_does_not_raise(db, monkeypatch):
    _seed_non_flac_track(db)
    blob_store = FakeBlobStore(raises=True)

    import app.adapters.blobstore_s3 as blobstore_s3

    monkeypatch.setattr(blobstore_s3, "get_blobstore", lambda: blob_store)

    await worker._run_transcode_backfill(db)  # must not raise
