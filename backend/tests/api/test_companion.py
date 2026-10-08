import json
from io import BytesIO

import pytest
from PIL import Image

from app.adapters import blobstore_s3
from app.capture import companion_ingest
from app.db.models import (
    AudioTrack,
    CaptureSession,
    CaptureState,
    CoverageInterval,
    Keyframe,
    Org,
    PipelineJob,
    User,
)


class Store:
    def __init__(self):
        self.objects = {}

    async def put(self, key, data, content_type=None):
        uri = f"blob://{key}"
        self.objects[uri] = data
        return uri

    async def put_stream(self, key, stream, content_type=None):
        data = b"".join([chunk async for chunk in stream])
        return await self.put(key, data, content_type)

    async def get(self, uri):
        return self.objects[uri]

    async def exists(self, uri):
        return uri in self.objects


@pytest.fixture
def store(monkeypatch):
    instance = Store()
    monkeypatch.setattr(blobstore_s3, "get_blobstore", lambda: instance)
    monkeypatch.setattr(companion_ingest, "get_blobstore", lambda: instance)
    return instance


def start(client, db):
    if db.get(User, "11111111-1111-1111-1111-111111111111") is None:
        db.add(User(id="11111111-1111-1111-1111-111111111111", email="test@example.com"))
    org = Org(name="capture")
    db.add(org)
    db.commit()
    base = f"/api/v1/orgs/{org.id}/companion"
    response = client.post(base + "/sessions", json={
        "meeting_url": "https://meet.google.com/abc-defg-hij", "platform": "meet",
    })
    assert response.status_code == 200
    session_id = response.json()["session_id"]
    return org, session_id, base + f"/sessions/{session_id}"


def test_finalize_queues_once_without_running_ffmpeg(client, db_session, store):
    _, sid, base = start(client, db_session)
    for _ in range(2):
        result = client.post(base + "/finalize", json={"total_chunks": 2, "roster": []})
        assert result.status_code == 200
    assert db_session.query(PipelineJob).count() == 1
    assert db_session.query(AudioTrack).count() == 0
    assert db_session.get(CaptureSession, sid).state == CaptureState.ACQUIRING
    assert json.loads(next(iter(store.objects.values())))["total_chunks"] == 2
    result = client.post(base + "/chunks", data={"seq": 0}, files={"data": ("chunk.webm", b"a")})
    assert result.status_code == 409


def test_write_path_must_match_session_org(client, db_session, store):
    _, _, base = start(client, db_session)
    other = Org(name="other")
    db_session.add(other)
    db_session.commit()
    wrong = base.replace(base.split("/")[4], other.id)
    assert client.post(wrong + "/finalize", json={"total_chunks": 1}).status_code == 404
    assert client.post(wrong + "/chunks", data={"seq": 0}, files={"data": ("x", b"a")}).status_code == 404
    assert not store.objects


def test_keyframe_retry_is_idempotent_and_timing_is_validated(client, db_session, store):
    _, _, base = start(client, db_session)
    image = BytesIO()
    Image.new("RGB", (32, 18)).save(image, format="JPEG")
    for _ in range(2):
        assert client.post(base + "/keyframes", data={"seq": 0, "timestamp_s": 3.5},
                           files={"data": ("frame.jpg", image.getvalue())}).status_code == 200
    assert db_session.query(Keyframe).count() == 1
    assert client.post(base + "/keyframes", data={"seq": -1, "timestamp_s": "nan"},
                       files={"data": ("x", b"x")}).status_code == 422


def test_empty_capture_can_be_closed_honestly(client, db_session, store):
    _, sid, base = start(client, db_session)
    assert client.post(base + "/finalize", json={"total_chunks": 0}).status_code == 422
    for _ in range(2):
        assert client.post(base + "/abort", json={"error": "permission denied"}).status_code == 200
    assert db_session.get(CaptureSession, sid).state == CaptureState.FAILED
    assert db_session.query(CoverageInterval).count() == 1
    assert db_session.query(PipelineJob).count() == 0


async def test_acquire_reassembles_fragments_and_discloses_missing_mic(client, db_session, store, monkeypatch):
    _, sid, base = start(client, db_session)
    for seq, chunk in enumerate([b"header", b"tail"]):
        assert client.post(base + "/chunks", data={"seq": seq},
                           files={"data": ("chunk.webm", chunk)}).status_code == 200
    assert client.post(base + "/finalize", json={"total_chunks": 2,
        "microphone_captured": False, "duration_s": 10, "roster": ["Alice", "Alice"]}).status_code == 200

    def transcode(source, output):
        assert source.read_bytes() == b"headertail"
        output.write_bytes(b"flac")

    monkeypatch.setattr(companion_ingest, "transcode_webm_file", transcode)
    await companion_ingest.assemble_companion_capture(db_session, db_session.get(CaptureSession, sid))
    db_session.commit()
    await companion_ingest.assemble_companion_capture(db_session, db_session.get(CaptureSession, sid))
    assert db_session.query(AudioTrack).count() == 1
    assert db_session.query(CoverageInterval).one().end_s == 10


async def test_missing_fragment_is_retried_without_fabricating_continuity(client, db_session, store):
    _, sid, base = start(client, db_session)
    assert client.post(base + "/finalize", json={"total_chunks": 2}).status_code == 200
    with pytest.raises(RuntimeError, match="chunk 0 missing"):
        await companion_ingest.assemble_companion_capture(db_session, db_session.get(CaptureSession, sid))
    assert db_session.query(AudioTrack).count() == 0
