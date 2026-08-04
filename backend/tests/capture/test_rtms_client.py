"""RtmsSession driven end-to-end against a fake WebSocketConnector -- no
real network, no `websockets` import touched."""

import json

import pytest

from app.capture.rtms_client import RtmsSession
from app.capture.rtms_protocol import (
    CLIENT_READY_ACK,
    DATA_HAND_SHAKE_REQ,
    DATA_HAND_SHAKE_RESP,
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

    ready_ack = json.loads(signaling_conn.sent[1])
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
