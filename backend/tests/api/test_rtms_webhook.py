"""Zoom RTMS webhook receiver — full flow via the FastAPI test client with a
fake WebSocketConnector injected, no real network."""

import json

import pytest

from app.api import rtms_webhook
from app.config import get_settings
from app.db.models import AudioTrack, CaptureSession, ConsentRecord, Meeting, PipelineJob


class FakeWsConn:
    def __init__(self, scripted_recv: list) -> None:
        self._scripted_recv = list(scripted_recv)
        self.sent: list[str] = []

    async def send(self, data) -> None:
        self.sent.append(data if isinstance(data, str) else data.decode())

    async def recv(self):
        return self._scripted_recv.pop(0)

    async def close(self) -> None:
        pass


class FakeConnector:
    def __init__(self, signaling_conn: FakeWsConn, media_conn: FakeWsConn) -> None:
        self.signaling_conn = signaling_conn
        self.media_conn = media_conn

    async def connect(self, url: str):
        if url == "ws://fake-signaling":
            return self.signaling_conn
        if url == "ws://fake-media/audio":
            return self.media_conn
        raise AssertionError(f"unexpected connect url: {url}")


@pytest.fixture(autouse=True)
def _zoom_settings_and_connector():
    settings = get_settings()
    settings.zoom_client_id = "cid"
    settings.zoom_client_secret = "secret"
    settings.zoom_webhook_secret_token = "webhook-secret"

    signaling_conn = FakeWsConn(
        scripted_recv=[
            json.dumps(
                {
                    "msg_type": 2,
                    "media_server": {"server_urls": {"audio": "ws://fake-media/audio"}},
                }
            )
        ]
    )
    media_conn = FakeWsConn(
        scripted_recv=[
            json.dumps({"msg_type": 4}),
            b"\x01\x02\xff",
            json.dumps({"msg_type": 8, "state": 4, "reason": "STOP_BC_MEETING_ENDED"}),
        ]
    )
    rtms_webhook.set_websocket_connector(FakeConnector(signaling_conn, media_conn))
    yield
    rtms_webhook.set_websocket_connector(None)
    rtms_webhook._active_streams.clear()
    settings.zoom_client_id = None
    settings.zoom_client_secret = None
    settings.zoom_webhook_secret_token = None


def test_url_validation_challenge(client):
    resp = client.post(
        "/api/v1/webhooks/zoom/rtms",
        json={"event": "endpoint.url_validation", "payload": {"plainToken": "abc123"}},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["plainToken"] == "abc123"
    assert "encryptedToken" in body


async def test_rtms_started_then_stopped_finalizes_capture_session(client, db_session):
    started_resp = client.post(
        "/api/v1/webhooks/zoom/rtms",
        json={
            "event": "meeting.rtms_started",
            "payload": {
                "meeting_uuid": "muid-1",
                "operator_id": "op-1",
                "rtms_stream_id": "stream-1",
                "server_urls": "ws://fake-signaling",
            },
        },
    )
    assert started_resp.status_code == 200
    assert started_resp.json() == {"status": "accepted"}

    meeting = db_session.query(Meeting).filter(Meeting.platform_meeting_id == "muid-1").one()
    session = db_session.query(CaptureSession).filter(CaptureSession.meeting_id == meeting.id).one()
    assert session.mode == "A1"

    stopped_resp = client.post(
        "/api/v1/webhooks/zoom/rtms",
        json={
            "event": "meeting.rtms_stopped",
            "payload": {
                "meeting_uuid": "muid-1",
                "rtms_stream_id": "stream-1",
                "stop_reason": 6,
            },
        },
    )

    assert stopped_resp.status_code == 200
    body = stopped_resp.json()
    assert body["status"] == "finalized"
    assert body["capture_session_id"] == session.id

    db_session.refresh(session)
    track = (
        db_session.query(AudioTrack).filter(AudioTrack.capture_session_id == session.id).one()
    )
    assert track.uri.endswith(".flac") or track.uri.endswith(".wav")

    consent = (
        db_session.query(ConsentRecord)
        .filter(ConsentRecord.capture_session_id == session.id)
        .one()
    )
    assert consent.method == "host_setting"

    job = (
        db_session.query(PipelineJob)
        .filter(PipelineJob.capture_session_id == session.id)
        .one()
    )
    assert job.stage == "transcribe"


def test_rtms_stopped_unknown_stream_404s(client):
    resp = client.post(
        "/api/v1/webhooks/zoom/rtms",
        json={
            "event": "meeting.rtms_stopped",
            "payload": {"meeting_uuid": "muid-x", "rtms_stream_id": "unknown", "stop_reason": 1},
        },
    )

    assert resp.status_code == 404


def test_unhandled_event_400s(client):
    resp = client.post(
        "/api/v1/webhooks/zoom/rtms", json={"event": "something.else", "payload": {}}
    )

    assert resp.status_code == 400
