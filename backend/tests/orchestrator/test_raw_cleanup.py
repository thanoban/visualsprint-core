"""Tests for automatic post-pipeline raw-evidence deletion (raw_cleanup.py).

Uses an in-memory SQLite DB wired through the real ORM — no mocks of DB
layer — and a fake BlobStore that records which keys were deleted.
"""

import pytest
import sqlalchemy as sa
from sqlalchemy.orm import Session

from app.db.models import AudioTrack, CaptureSession, Meeting, Org
from app.orchestrator.raw_cleanup import delete_raw_audio, delete_raw_video

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class FakeBlob:
    def __init__(self):
        self.deleted: list[str] = []
        self.fail_on: set[str] = set()

    async def put(self, key, data, content_type="application/octet-stream"):
        return f"blob://{key}"

    async def put_stream(self, key, stream, content_type="application/octet-stream"):
        return f"blob://{key}"

    async def get(self, uri):
        return b""

    async def exists(self, uri):
        return True

    async def delete(self, uri):
        if uri in self.fail_on:
            raise OSError(f"simulated failure deleting {uri}")
        self.deleted.append(uri)

    async def presigned_url(self, uri, expires_s=3600):
        return f"https://example.com/{uri}"


def _make_db():
    engine = sa.create_engine("sqlite:///:memory:")
    from app.db.base import Base

    Base.metadata.create_all(engine)
    return Session(engine)


def _make_session(db: Session, mode: str = "D", video_uri: str = "") -> CaptureSession:
    org = Org(name="test-org")
    db.add(org)
    db.flush()
    meeting = Meeting(org_id=org.id, platform="meet", title="T")
    db.add(meeting)
    db.flush()
    cs = CaptureSession(org_id=org.id, meeting_id=meeting.id, mode=mode, video_uri=video_uri)
    db.add(cs)
    db.flush()
    return cs


# ---------------------------------------------------------------------------
# delete_raw_audio
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_raw_audio_clears_uri_and_calls_blob_delete():
    db = _make_db()
    cs = _make_session(db)
    track = AudioTrack(org_id=cs.org_id, capture_session_id=cs.id, uri="blob://audio/a.wav")
    db.add(track)
    db.flush()
    blob = FakeBlob()

    deleted = await delete_raw_audio(db, cs.id, blob)

    assert deleted == 1
    assert "blob://audio/a.wav" in blob.deleted
    assert track.uri == ""


@pytest.mark.asyncio
async def test_delete_raw_audio_skips_already_empty_uri():
    db = _make_db()
    cs = _make_session(db)
    track = AudioTrack(org_id=cs.org_id, capture_session_id=cs.id, uri="")
    db.add(track)
    db.flush()
    blob = FakeBlob()

    deleted = await delete_raw_audio(db, cs.id, blob)

    assert deleted == 0
    assert blob.deleted == []


@pytest.mark.asyncio
async def test_delete_raw_audio_multiple_tracks():
    db = _make_db()
    cs = _make_session(db)
    for i in range(3):
        db.add(AudioTrack(org_id=cs.org_id, capture_session_id=cs.id, uri=f"blob://audio/{i}.wav"))
    db.flush()
    blob = FakeBlob()

    deleted = await delete_raw_audio(db, cs.id, blob)

    assert deleted == 3
    assert len(blob.deleted) == 3


@pytest.mark.asyncio
async def test_delete_raw_audio_blob_error_swallowed_uri_still_cleared():
    """A GCS hiccup must not roll back the transcription — the blob key is
    cleared so a retry won't attempt to re-delete a potentially missing blob."""
    db = _make_db()
    cs = _make_session(db)
    track = AudioTrack(org_id=cs.org_id, capture_session_id=cs.id, uri="blob://audio/x.wav")
    db.add(track)
    db.flush()
    blob = FakeBlob()
    blob.fail_on.add("blob://audio/x.wav")

    deleted = await delete_raw_audio(db, cs.id, blob)

    assert deleted == 1  # counted as "processed" even if blob.delete errored
    assert track.uri == ""


@pytest.mark.asyncio
async def test_delete_raw_audio_idempotent():
    db = _make_db()
    cs = _make_session(db)
    track = AudioTrack(org_id=cs.org_id, capture_session_id=cs.id, uri="blob://audio/y.wav")
    db.add(track)
    db.flush()
    blob = FakeBlob()

    await delete_raw_audio(db, cs.id, blob)
    deleted2 = await delete_raw_audio(db, cs.id, blob)

    assert deleted2 == 0
    assert blob.deleted.count("blob://audio/y.wav") == 1


@pytest.mark.asyncio
async def test_delete_raw_audio_skips_track_that_is_also_video_uri():
    """Mode D video upload: AudioTrack.uri and CaptureSession.video_uri share
    the same blob. delete_raw_audio must NOT delete it — the screen stage still
    needs it. delete_raw_video handles the deferred deletion after screen."""
    db = _make_db()
    cs = _make_session(db, video_uri="blob://audio/vid.mp4")
    track = AudioTrack(org_id=cs.org_id, capture_session_id=cs.id, uri="blob://audio/vid.mp4")
    db.add(track)
    db.flush()
    blob = FakeBlob()

    deleted = await delete_raw_audio(db, cs.id, blob)

    assert deleted == 0
    assert blob.deleted == []
    assert track.uri == "blob://audio/vid.mp4"  # left intact for screen stage


@pytest.mark.asyncio
async def test_delete_raw_video_also_clears_matching_audio_track_uri():
    """After screen stage: delete_raw_video must clear AudioTrack.uri when it
    points to the same blob as video_uri (the deferred Mode D case)."""
    db = _make_db()
    cs = _make_session(db, video_uri="blob://audio/vid.mp4")
    track = AudioTrack(org_id=cs.org_id, capture_session_id=cs.id, uri="blob://audio/vid.mp4")
    db.add(track)
    db.flush()
    blob = FakeBlob()

    result = await delete_raw_video(db, cs.id, "blob://audio/vid.mp4", blob)

    assert result is True
    assert "blob://audio/vid.mp4" in blob.deleted
    assert cs.video_uri == ""
    assert track.uri == ""  # also cleared


# ---------------------------------------------------------------------------
# delete_raw_video
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_raw_video_clears_video_uri():
    db = _make_db()
    cs = _make_session(db, video_uri="blob://video/meeting.mp4")
    blob = FakeBlob()

    result = await delete_raw_video(db, cs.id, "blob://video/meeting.mp4", blob)

    assert result is True
    assert "blob://video/meeting.mp4" in blob.deleted
    assert cs.video_uri == ""


@pytest.mark.asyncio
async def test_delete_raw_video_no_video_uri_is_noop():
    db = _make_db()
    cs = _make_session(db, video_uri="")
    blob = FakeBlob()

    result = await delete_raw_video(db, cs.id, "", blob)

    assert result is False
    assert blob.deleted == []


@pytest.mark.asyncio
async def test_delete_raw_video_blob_error_swallowed_uri_cleared():
    db = _make_db()
    cs = _make_session(db, video_uri="blob://video/z.mp4")
    blob = FakeBlob()
    blob.fail_on.add("blob://video/z.mp4")

    result = await delete_raw_video(db, cs.id, "blob://video/z.mp4", blob)

    assert result is True
    assert cs.video_uri == ""


@pytest.mark.asyncio
async def test_delete_raw_video_idempotent():
    db = _make_db()
    cs = _make_session(db, video_uri="blob://video/idem.mp4")
    blob = FakeBlob()

    await delete_raw_video(db, cs.id, "blob://video/idem.mp4", blob)
    result2 = await delete_raw_video(db, cs.id, "blob://video/idem.mp4", blob)

    assert result2 is False
    assert blob.deleted.count("blob://video/idem.mp4") == 1
