"""Zoom RTMS webhook receiver — full flow via the FastAPI test client with a
fake WebSocketConnector injected, no real network."""

import asyncio
import json
import time

import pytest

from app.api import rtms_webhook
from app.capture.rtms_protocol import compute_webhook_signature
from app.config import get_settings
from app.db.models import (
    AudioTrack,
    CaptureSession,
    ConsentRecord,
    Meeting,
    Org,
    OrgConnection,
    Participant,
    PipelineJob,
    PlatformSpeakerLabel,
)


def _signed_post(client, event: str, payload: dict):
    """Every real Zoom webhook event (other than the initial url_validation
    handshake) must be signed -- see rtms_protocol.verify_webhook_signature.
    Signs the exact bytes sent, matching what the server verifies against."""
    body = json.dumps({"event": event, "payload": payload}).encode()
    timestamp = str(int(time.time() * 1000))
    settings = get_settings()
    signature = compute_webhook_signature(body, timestamp, settings.zoom_webhook_secret_token)
    return client.post(
        "/api/v1/webhooks/zoom/rtms",
        content=body,
        headers={
            "content-type": "application/json",
            "x-zm-request-timestamp": timestamp,
            "x-zm-signature": signature,
        },
    )


class FakeWsConn:
    def __init__(self, scripted_recv: list) -> None:
        self._scripted_recv = list(scripted_recv)
        self.sent: list[str] = []

    async def send(self, data) -> None:
        self.sent.append(data if isinstance(data, str) else data.decode())

    async def recv(self):
        # A real websocket recv() always suspends until a frame arrives --
        # RtmsSession.run() relies on that to let its concurrent signaling
        # event loop actually get scheduled (see app/capture/rtms_client.py
        # and tests/capture/test_rtms_client.py's identical fix).
        await asyncio.sleep(0)
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
    started_resp = _signed_post(
        client,
        "meeting.rtms_started",
        {
            "meeting_uuid": "muid-1",
            "operator_id": "op-1",
            "rtms_stream_id": "stream-1",
            "server_urls": "ws://fake-signaling",
        },
    )
    assert started_resp.status_code == 200
    assert started_resp.json() == {"status": "accepted"}

    meeting = db_session.query(Meeting).filter(Meeting.platform_meeting_id == "muid-1").one()
    session = db_session.query(CaptureSession).filter(CaptureSession.meeting_id == meeting.id).one()
    assert session.mode == "A1"

    stopped_resp = _signed_post(
        client,
        "meeting.rtms_stopped",
        {
            "meeting_uuid": "muid-1",
            "rtms_stream_id": "stream-1",
            "stop_reason": 6,
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
    # "diarize", not "transcribe" -- RTMS skips "acquire" (it already wrote
    # its own AudioTrack above) but must still enter the pipeline at the
    # stage right after acquire, same as every other capture mode, so its
    # mixed-audio session gets speaker separation like Mode D/A2 do.
    assert job.stage == "diarize"


async def test_rtms_stopped_persists_roster_and_speaker_labels(client, db_session):
    """docs/13-participant-identity-capture.md's Option A, end to end
    through the real webhook (not just RtmsSession in isolation): a
    PARTICIPANT_JOIN + ACTIVE_SPEAKER_CHANGE event pair reaching
    rtms_stopped must land as real Participant/PlatformSpeakerLabel rows,
    the same shape identity resolution already consumes for Meet/Teams."""
    import time

    now_ms = time.time() * 1000.0
    signaling_conn = FakeWsConn(
        scripted_recv=[
            json.dumps(
                {
                    "msg_type": 2,
                    "media_server": {"server_urls": {"audio": "ws://fake-media/audio"}},
                }
            ),
            json.dumps(
                {
                    "msg_type": 6,  # EVENT_UPDATE
                    "content": {
                        "event_type": 3,  # PARTICIPANT_JOIN
                        "user_id": "u1",
                        "user_name": "Nimal",
                        "timestamp": now_ms,
                    },
                }
            ),
            json.dumps(
                {
                    "msg_type": 6,
                    "content": {
                        "event_type": 2,  # ACTIVE_SPEAKER_CHANGE
                        "user_id": "u1",
                        "user_name": "Nimal",
                        "timestamp": now_ms + 500,
                    },
                }
            ),
            json.dumps(
                {
                    "msg_type": 6,
                    "content": {
                        "event_type": 2,
                        "user_id": "u2",
                        "user_name": "Kamal",
                        "timestamp": now_ms + 3000,
                    },
                }
            ),
        ]
    )
    media_conn = FakeWsConn(
        scripted_recv=[
            json.dumps({"msg_type": 4}),
            b"\x01\x02\xff",
            # Slack (see test_rtms_client.py's identical comment) so the
            # concurrent signaling event loop has room to drain before the
            # media loop reaches STREAM_STATE_TERMINATED.
            *(json.dumps({"msg_type": 12, "timestamp": i}) for i in range(5)),
            json.dumps({"msg_type": 8, "state": 4, "reason": "STOP_BC_MEETING_ENDED"}),
        ]
    )
    rtms_webhook.set_websocket_connector(FakeConnector(signaling_conn, media_conn))

    started_resp = _signed_post(
        client,
        "meeting.rtms_started",
        {
            "meeting_uuid": "muid-roster",
            "operator_id": "op-1",
            "rtms_stream_id": "stream-roster",
            "server_urls": "ws://fake-signaling",
        },
    )
    assert started_resp.status_code == 200

    meeting = db_session.query(Meeting).filter(Meeting.platform_meeting_id == "muid-roster").one()
    session = db_session.query(CaptureSession).filter(CaptureSession.meeting_id == meeting.id).one()

    stopped_resp = _signed_post(
        client,
        "meeting.rtms_stopped",
        {
            "meeting_uuid": "muid-roster",
            "rtms_stream_id": "stream-roster",
            "stop_reason": 6,
        },
    )
    assert stopped_resp.status_code == 200

    participants = (
        db_session.query(Participant).filter(Participant.capture_session_id == session.id).all()
    )
    assert len(participants) == 1
    assert participants[0].display_name == "Nimal"

    labels = (
        db_session.query(PlatformSpeakerLabel)
        .filter(PlatformSpeakerLabel.capture_session_id == session.id)
        .all()
    )
    assert len(labels) == 1
    assert labels[0].display_name == "Nimal"
    assert labels[0].provider == "A1"
    assert labels[0].end_s > labels[0].start_s


def test_rtms_stopped_unknown_stream_404s(client):
    resp = _signed_post(
        client,
        "meeting.rtms_stopped",
        {"meeting_uuid": "muid-x", "rtms_stream_id": "unknown", "stop_reason": 1},
    )

    assert resp.status_code == 404


def test_unhandled_event_400s(client):
    resp = _signed_post(client, "something.else", {})

    assert resp.status_code == 400


def test_missing_signature_is_rejected(client):
    resp = client.post(
        "/api/v1/webhooks/zoom/rtms",
        json={
            "event": "meeting.rtms_started",
            "payload": {
                "meeting_uuid": "muid-forged",
                "rtms_stream_id": "stream-forged",
                "server_urls": "ws://fake-signaling",
            },
        },
    )

    assert resp.status_code == 401


def test_wrong_signature_is_rejected(client):
    body = json.dumps(
        {
            "event": "meeting.rtms_started",
            "payload": {
                "meeting_uuid": "muid-forged",
                "rtms_stream_id": "stream-forged",
                "server_urls": "ws://fake-signaling",
            },
        }
    ).encode()
    resp = client.post(
        "/api/v1/webhooks/zoom/rtms",
        content=body,
        headers={
            "content-type": "application/json",
            "x-zm-request-timestamp": "12345",
            "x-zm-signature": "v0=not-the-right-signature",
        },
    )

    assert resp.status_code == 401


def test_resolve_org_for_zoom_account_falls_back_to_default_when_account_id_is_none(db_session):
    org = rtms_webhook._resolve_org_for_zoom_account(db_session, None)
    assert org.name == "default"


def test_resolve_org_for_zoom_account_falls_back_to_default_when_unrecognized(db_session):
    org = rtms_webhook._resolve_org_for_zoom_account(db_session, "some-other-account-id")
    assert org.name == "default"


def test_resolve_org_for_zoom_account_finds_the_connected_org(db_session):
    connected_org = Org(name="acme")
    db_session.add(connected_org)
    db_session.flush()
    db_session.add(
        OrgConnection(
            org_id=connected_org.id,
            provider="zoom",
            account_label="ops@acme.test",
            external_id="zoom-account-abc",
            secret_ref="oauth/zoom/x",
        )
    )
    db_session.commit()

    org = rtms_webhook._resolve_org_for_zoom_account(db_session, "zoom-account-abc")

    assert org.id == connected_org.id


async def test_rtms_started_routes_to_the_connected_org_not_default(client, db_session):
    """The regression this whole fix closes: two different Zoom accounts
    must land in two different orgs, not both collapse into "default"."""
    connected_org = Org(name="acme")
    db_session.add(connected_org)
    db_session.flush()
    db_session.add(
        OrgConnection(
            org_id=connected_org.id,
            provider="zoom",
            account_label="ops@acme.test",
            external_id="zoom-account-abc",
            secret_ref="oauth/zoom/x",
        )
    )
    db_session.commit()

    resp = _signed_post(
        client,
        "meeting.rtms_started",
        {
            "account_id": "zoom-account-abc",
            "meeting_uuid": "muid-acme",
            "rtms_stream_id": "stream-acme",
            "server_urls": "ws://fake-signaling",
        },
    )
    assert resp.status_code == 200

    meeting = db_session.query(Meeting).filter(Meeting.platform_meeting_id == "muid-acme").one()
    assert meeting.org_id == connected_org.id


async def test_rtms_started_with_unrecognized_account_id_falls_back_to_default(client, db_session):
    resp = _signed_post(
        client,
        "meeting.rtms_started",
        {
            "account_id": "never-connected",
            "meeting_uuid": "muid-fallback",
            "rtms_stream_id": "stream-fallback",
            "server_urls": "ws://fake-signaling",
        },
    )
    assert resp.status_code == 200

    meeting = db_session.query(Meeting).filter(Meeting.platform_meeting_id == "muid-fallback").one()
    default_org = db_session.query(Org).filter(Org.name == "default").one()
    assert meeting.org_id == default_org.id
