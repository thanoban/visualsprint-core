"""RtmsSession driven end-to-end against a fake WebSocketConnector -- no
real network, no `websockets` import touched."""

import asyncio
import json

import pytest

from app.capture.rtms_client import RtmsSession
from app.capture.rtms_protocol import (
    CLIENT_READY_ACK,
    DATA_HAND_SHAKE_REQ,
    DATA_HAND_SHAKE_RESP,
    EVENT_SUBSCRIPTION,
    EVENT_TYPE_ACTIVE_SPEAKER_CHANGE,
    EVENT_TYPE_PARTICIPANT_JOIN,
    EVENT_UPDATE,
    KEEP_ALIVE_REQ,
    KEEP_ALIVE_RESP,
    SIGNALING_HAND_SHAKE_REQ,
    SIGNALING_HAND_SHAKE_RESP,
    STREAM_STATE_TERMINATED,
    STREAM_STATE_UPDATE,
    compute_signature,
)


class FakeWsConn:
    def __init__(self, scripted_recv: list) -> None:
        self._scripted_recv = list(scripted_recv)
        self.sent: list[str] = []
        self.closed = False

    async def send(self, data: str | bytes) -> None:
        self.sent.append(data if isinstance(data, str) else data.decode())

    async def recv(self):
        # A real websocket recv() always suspends the caller until a frame
        # arrives, which is what actually gives the concurrent signaling
        # event loop (run() creates it as an asyncio task alongside the
        # media loop) a chance to run. Without this yield, an all-synchronous
        # fake lets the media loop race straight through to completion and
        # cancel the event task before it ever executes once.
        await asyncio.sleep(0)
        return self._scripted_recv.pop(0)

    async def close(self) -> None:
        self.closed = True


class FakeConnector:
    def __init__(self, signaling_conn: FakeWsConn, media_conn: FakeWsConn) -> None:
        self._by_url = {}
        self.signaling_conn = signaling_conn
        self.media_conn = media_conn
        self.connected_urls: list[str] = []

    async def connect(self, url: str):
        self.connected_urls.append(url)
        if url == "ws://signaling":
            return self.signaling_conn
        if url == "ws://media/audio":
            return self.media_conn
        raise AssertionError(f"unexpected connect url: {url}")


@pytest.fixture
def client_creds():
    return {"client_id": "cid", "client_secret": "secret"}


async def test_rtms_session_full_handshake_and_audio_accumulation(client_creds):
    signaling_conn = FakeWsConn(
        scripted_recv=[
            json.dumps(
                {
                    "msg_type": SIGNALING_HAND_SHAKE_RESP,
                    "media_server": {"server_urls": {"audio": "ws://media/audio"}},
                }
            ),
        ]
    )
    media_conn = FakeWsConn(
        scripted_recv=[
            json.dumps({"msg_type": DATA_HAND_SHAKE_RESP}),
            b"\x01\x02\x03\xff",  # binary audio frame 1
            json.dumps({"msg_type": KEEP_ALIVE_REQ, "timestamp": 42}),
            b"\x04\x05\x06\xfe",  # binary audio frame 2
            json.dumps(
                {
                    "msg_type": STREAM_STATE_UPDATE,
                    "state": STREAM_STATE_TERMINATED,
                    "reason": "STOP_BC_MEETING_ENDED",
                }
            ),
        ]
    )
    connector = FakeConnector(signaling_conn, media_conn)
    session = RtmsSession(connector=connector, **client_creds)

    result = await session.run(
        meeting_uuid="muid", rtms_stream_id="sid", signaling_url="ws://signaling"
    )

    assert result.pcm_bytes == b"\x01\x02\x03\xff\x04\x05\x06\xfe"
    assert result.stop_reason == "STOP_BC_MEETING_ENDED"
    assert signaling_conn.closed
    assert media_conn.closed

    signaling_handshake = json.loads(signaling_conn.sent[0])
    assert signaling_handshake["msg_type"] == SIGNALING_HAND_SHAKE_REQ
    assert signaling_handshake["signature"] == compute_signature("cid", "muid", "sid", "secret")

    event_subscription = json.loads(signaling_conn.sent[1])
    assert event_subscription["msg_type"] == EVENT_SUBSCRIPTION

    ready_ack = json.loads(signaling_conn.sent[2])
    assert ready_ack == {"msg_type": CLIENT_READY_ACK, "rtms_stream_id": "sid"}

    media_handshake = json.loads(media_conn.sent[0])
    assert media_handshake["msg_type"] == DATA_HAND_SHAKE_REQ

    keep_alive_resp = json.loads(media_conn.sent[1])
    assert keep_alive_resp == {"msg_type": KEEP_ALIVE_RESP, "timestamp": 42}


async def test_rtms_session_raises_on_bad_signaling_handshake(client_creds):
    signaling_conn = FakeWsConn(scripted_recv=[json.dumps({"msg_type": 999})])
    media_conn = FakeWsConn(scripted_recv=[])
    connector = FakeConnector(signaling_conn, media_conn)
    session = RtmsSession(connector=connector, **client_creds)

    with pytest.raises(RuntimeError, match="unexpected signaling handshake reply"):
        await session.run(meeting_uuid="muid", rtms_stream_id="sid", signaling_url="ws://signaling")

    assert signaling_conn.closed


async def test_rtms_session_captures_roster_and_speaker_labels_from_events(client_creds):
    """End-to-end through the real session, not just _EventTracker in
    isolation -- proves EVENT_UPDATE messages arriving on the *signaling*
    connection actually reach the tracker while audio is being read
    concurrently from *media* (docs/13-participant-identity-capture.md:
    this is the structural fix, not just new message parsing)."""
    import time

    now_ms = time.time() * 1000.0

    signaling_conn = FakeWsConn(
        scripted_recv=[
            json.dumps(
                {
                    "msg_type": SIGNALING_HAND_SHAKE_RESP,
                    "media_server": {"server_urls": {"audio": "ws://media/audio"}},
                }
            ),
            json.dumps(
                {
                    "msg_type": EVENT_UPDATE,
                    "content": {
                        "event_type": EVENT_TYPE_PARTICIPANT_JOIN,
                        "user_id": "u1",
                        "user_name": "Nimal",
                        "timestamp": now_ms,
                    },
                }
            ),
            json.dumps(
                {
                    "msg_type": EVENT_UPDATE,
                    "content": {
                        "event_type": EVENT_TYPE_ACTIVE_SPEAKER_CHANGE,
                        "user_id": "u1",
                        "user_name": "Nimal",
                        "timestamp": now_ms + 1000,
                    },
                }
            ),
            json.dumps(
                {
                    "msg_type": EVENT_UPDATE,
                    "content": {
                        "event_type": EVENT_TYPE_ACTIVE_SPEAKER_CHANGE,
                        "user_id": "u2",
                        "user_name": "Kamal",
                        "timestamp": now_ms + 5000,
                    },
                }
            ),
        ]
    )
    media_conn = FakeWsConn(
        scripted_recv=[
            json.dumps({"msg_type": DATA_HAND_SHAKE_RESP}),
            b"\x01\x02\x03\xff",
            # A handful of harmless keep-alive round trips -- not needed for
            # the audio itself, but each one is a recv() the fake suspends
            # on (see FakeWsConn.recv()'s asyncio.sleep(0)), giving the
            # concurrent signaling event loop ample cooperative-scheduling
            # turns to fully drain its 3 queued events well before the
            # media loop reaches STREAM_STATE_TERMINATED. Without slack
            # here this test's outcome depends on exact task-interleaving
            # order, which asyncio does not guarantee.
            *(json.dumps({"msg_type": KEEP_ALIVE_REQ, "timestamp": i}) for i in range(5)),
            json.dumps(
                {
                    "msg_type": STREAM_STATE_UPDATE,
                    "state": STREAM_STATE_TERMINATED,
                    "reason": "STOP_BC_MEETING_ENDED",
                }
            ),
        ]
    )
    connector = FakeConnector(signaling_conn, media_conn)
    session = RtmsSession(connector=connector, **client_creds)

    result = await session.run(
        meeting_uuid="muid", rtms_stream_id="sid", signaling_url="ws://signaling"
    )

    assert result.pcm_bytes == b"\x01\x02\x03\xff"
    assert len(result.roster) == 1
    assert result.roster[0].display_name == "Nimal"
    assert result.roster[0].platform_user_id == "u1"

    # Nimal's active-speaker span closes when Kamal's change arrives --
    # a real span with a positive duration, not a same-instant no-op.
    assert len(result.speaker_labels) == 1
    assert result.speaker_labels[0].display_name == "Nimal"
    assert result.speaker_labels[0].end_s > result.speaker_labels[0].start_s

    event_subscription = json.loads(signaling_conn.sent[1])
    assert event_subscription["msg_type"] == EVENT_SUBSCRIPTION
    subscribed_types = {e["event_type"] for e in event_subscription["events"]}
    assert EVENT_TYPE_PARTICIPANT_JOIN in subscribed_types
    assert EVENT_TYPE_ACTIVE_SPEAKER_CHANGE in subscribed_types


async def test_event_subscription_failure_does_not_break_audio_capture(client_creds):
    """The one thing this integration cannot degrade on is audio -- a
    subscription rejection (or any signaling-side error) must not prevent
    the media loop from running."""

    class FailingSubscribeSignalingConn(FakeWsConn):
        async def send(self, data):
            payload = json.loads(data if isinstance(data, str) else data.decode())
            if payload.get("msg_type") == EVENT_SUBSCRIPTION:
                raise ConnectionError("subscription rejected")
            await super().send(data)

    signaling_conn = FailingSubscribeSignalingConn(
        scripted_recv=[
            json.dumps(
                {
                    "msg_type": SIGNALING_HAND_SHAKE_RESP,
                    "media_server": {"server_urls": {"audio": "ws://media/audio"}},
                }
            ),
        ]
    )
    media_conn = FakeWsConn(
        scripted_recv=[
            json.dumps({"msg_type": DATA_HAND_SHAKE_RESP}),
            b"\x01\x02",
            json.dumps(
                {"msg_type": STREAM_STATE_UPDATE, "state": STREAM_STATE_TERMINATED, "reason": "x"}
            ),
        ]
    )
    connector = FakeConnector(signaling_conn, media_conn)
    session = RtmsSession(connector=connector, **client_creds)

    result = await session.run(
        meeting_uuid="muid", rtms_stream_id="sid", signaling_url="ws://signaling"
    )

    assert result.pcm_bytes == b"\x01\x02"
    assert result.roster == []
    assert result.speaker_labels == []


class TestEventTracker:
    """Deterministic tests for _EventTracker in isolation -- no websockets,
    no wall-clock uncertainty (explicit stream_start_ms/timestamps), so the
    span-closing arithmetic is pinned exactly."""

    def test_participant_join_adds_a_roster_entry(self):
        from app.capture.rtms_client import _EventTracker

        tracker = _EventTracker(stream_start_ms=1_000_000.0)
        tracker.handle(
            EVENT_TYPE_PARTICIPANT_JOIN,
            {"user_id": "u1", "user_name": "Nimal", "timestamp": 1_000_000.0},
        )

        assert len(tracker.roster) == 1
        assert tracker.roster[0].display_name == "Nimal"
        assert tracker.roster[0].platform_user_id == "u1"

    def test_active_speaker_change_closes_the_prior_span(self):
        from app.capture.rtms_client import _EventTracker

        tracker = _EventTracker(stream_start_ms=1_000_000.0)
        tracker.handle(
            EVENT_TYPE_ACTIVE_SPEAKER_CHANGE,
            {"user_id": "u1", "user_name": "Nimal", "timestamp": 1_001_000.0},  # +1s
        )
        tracker.handle(
            EVENT_TYPE_ACTIVE_SPEAKER_CHANGE,
            {"user_id": "u2", "user_name": "Kamal", "timestamp": 1_004_000.0},  # +4s
        )

        assert len(tracker.speaker_labels) == 1
        span = tracker.speaker_labels[0]
        assert span.display_name == "Nimal"
        assert span.start_s == pytest.approx(1.0)
        assert span.end_s == pytest.approx(4.0)

    def test_close_finalizes_the_last_open_span(self):
        from app.capture.rtms_client import _EventTracker

        tracker = _EventTracker(stream_start_ms=1_000_000.0)
        tracker.handle(
            EVENT_TYPE_ACTIVE_SPEAKER_CHANGE,
            {"user_id": "u1", "user_name": "Nimal", "timestamp": 1_001_000.0},
        )
        tracker.close(end_s=10.0)

        assert len(tracker.speaker_labels) == 1
        assert tracker.speaker_labels[0].start_s == pytest.approx(1.0)
        assert tracker.speaker_labels[0].end_s == pytest.approx(10.0)

    def test_zero_duration_span_is_dropped_not_emitted_as_noise(self):
        """Two speaker-change events at the identical timestamp must not
        produce a meaningless zero-length span."""
        from app.capture.rtms_client import _EventTracker

        tracker = _EventTracker(stream_start_ms=1_000_000.0)
        tracker.handle(
            EVENT_TYPE_ACTIVE_SPEAKER_CHANGE,
            {"user_id": "u1", "user_name": "Nimal", "timestamp": 1_001_000.0},
        )
        tracker.handle(
            EVENT_TYPE_ACTIVE_SPEAKER_CHANGE,
            {"user_id": "u2", "user_name": "Kamal", "timestamp": 1_001_000.0},
        )

        assert tracker.speaker_labels == []

    def test_unrecognized_event_shape_is_logged_once_and_never_raises(self):
        """The exact EVENT_UPDATE content shape isn't confirmed against a
        primary source yet (see rtms_client.py's module docstring) -- an
        unrecognized shape must degrade to a logged warning, never a crash
        that could take down the whole capture session."""
        from app.capture.rtms_client import _EventTracker

        tracker = _EventTracker(stream_start_ms=1_000_000.0)
        # No recognizable user_id/user_name anywhere in this content.
        tracker.handle(EVENT_TYPE_PARTICIPANT_JOIN, {"something_else": "unrecognized-shape"})
        tracker.handle(EVENT_TYPE_PARTICIPANT_JOIN, {"still_unrecognized": True})

        assert tracker.roster == []
        assert tracker._logged_unrecognized_shape is True

    def test_participant_extraction_finds_nested_participant_object(self):
        from app.capture.rtms_client import _extract_participant

        user_id, user_name = _extract_participant(
            {"participant": {"user_id": "u9", "user_name": "Saman"}}
        )

        assert user_id == "u9"
        assert user_name == "Saman"

    def test_participant_extraction_finds_participants_array(self):
        from app.capture.rtms_client import _extract_participant

        user_id, user_name = _extract_participant(
            {"participants": [{"userId": "u5", "userName": "Kavya"}]}
        )

        assert user_id == "u5"
        assert user_name == "Kavya"

    def test_participant_extraction_returns_none_on_unrecognized_shape(self):
        from app.capture.rtms_client import _extract_participant

        assert _extract_participant({"nothing_recognizable": True}) == (None, None)
