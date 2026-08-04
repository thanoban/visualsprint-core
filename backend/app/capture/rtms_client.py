"""RtmsSession — drives one live Zoom RTMS stream from signaling handshake
to stream termination, accumulating audio bytes in memory.

`WebSocketConnector` is the swap point (CLAUDE.md rule 4): production wires
a real `websockets`-backed implementation, tests inject a fake that never
touches the network — same injection shape as `S3ClientBackend` in
adapters/blobstore_s3.py and `http_client` in capture/zoom_adapter.py.

Scope note: this accumulates one mixed audio stream, not per-participant
tracks — Zoom's per-participant binary framing (MEDIA_DATA_OPTION.AUDIO_
MULTI_STREAMS) isn't documented in any public source, and guessing it would
misrepresent identity-quality confidence rather than honestly degrade it
(docs/03-capture.md: "weaker modes yield honestly lower confidence, never
silent degradation"). Mixed-track is the same tier A2 already accepts for
Meet/Teams.
"""

from dataclasses import dataclass, field
from typing import Protocol

from app.capture.rtms_protocol import (
    DATA_HAND_SHAKE_RESP,
    KEEP_ALIVE_REQ,
    MEDIA_DATA_AUDIO,
    SIGNALING_HAND_SHAKE_RESP,
    STREAM_STATE_TERMINATED,
    STREAM_STATE_UPDATE,
    build_client_ready_ack,
    build_keep_alive_resp,
    build_media_handshake,
    build_signaling_handshake,
    parse_media_message,
)


class WebSocketConn(Protocol):
    async def send(self, data: str | bytes) -> None: ...
    async def recv(self) -> str | bytes: ...
    async def close(self) -> None: ...


class WebSocketConnector(Protocol):
    async def connect(self, url: str) -> WebSocketConn: ...


@dataclass
class RtmsResult:
    pcm_bytes: bytes
    stop_reason: str | int | None


@dataclass
class _Buffer:
    chunks: list[bytes] = field(default_factory=list)

    def add(self, chunk: bytes) -> None:
        self.chunks.append(chunk)

    def combined(self) -> bytes:
        return b"".join(self.chunks)


class RtmsSession:
    def __init__(
        self,
        *,
        connector: WebSocketConnector,
        client_id: str,
        client_secret: str,
    ) -> None:
        self._connector = connector
        self._client_id = client_id
        self._client_secret = client_secret

    async def run(self, *, meeting_uuid: str, rtms_stream_id: str, signaling_url: str) -> RtmsResult:
        signaling = await self._connector.connect(signaling_url)
        try:
            await self._send_json(
                signaling,
                build_signaling_handshake(
                    client_id=self._client_id,
                    meeting_uuid=meeting_uuid,
                    rtms_stream_id=rtms_stream_id,
                    client_secret=self._client_secret,
                ),
            )

            handshake_resp = await self._recv_json(signaling)
            if handshake_resp.get("msg_type") != SIGNALING_HAND_SHAKE_RESP:
                raise RuntimeError(f"unexpected signaling handshake reply: {handshake_resp!r}")
            audio_url = handshake_resp["media_server"]["server_urls"]["audio"]

            media = await self._connector.connect(audio_url)
            try:
                await self._send_json(
                    media,
                    build_media_handshake(
                        client_id=self._client_id,
                        meeting_uuid=meeting_uuid,
                        rtms_stream_id=rtms_stream_id,
                        client_secret=self._client_secret,
                    ),
                )
                media_handshake_resp = await self._recv_json(media)
                if media_handshake_resp.get("msg_type") != DATA_HAND_SHAKE_RESP:
                    raise RuntimeError(f"unexpected media handshake reply: {media_handshake_resp!r}")

                await self._send_json(signaling, build_client_ready_ack(rtms_stream_id=rtms_stream_id))

                buffer = _Buffer()
                stop_reason: str | int | None = None
                while True:
                    raw = await media.recv()
                    message, audio_chunk = parse_media_message(raw)
                    if audio_chunk is not None:
                        buffer.add(audio_chunk)
                        continue
                    assert message is not None
                    msg_type = message.get("msg_type")
                    if msg_type == MEDIA_DATA_AUDIO:
                        # Some deployments wrap audio in a JSON envelope
                        # instead of sending raw binary frames -- handle both
                        # shapes rather than assume only one is real.
                        content = message.get("content", {})
                        data = content.get("data")
                        if data:
                            buffer.add(data.encode() if isinstance(data, str) else bytes(data))
                    elif msg_type == KEEP_ALIVE_REQ:
                        await self._send_json(
                            media, build_keep_alive_resp(timestamp=message.get("timestamp"))
                        )
                    elif msg_type == STREAM_STATE_UPDATE:
                        stop_reason = message.get("reason")
                        if message.get("state") == STREAM_STATE_TERMINATED:
                            break
                    # other control message types are ignored -- not needed
                    # for this audio-only, mixed-track slice.

                return RtmsResult(pcm_bytes=buffer.combined(), stop_reason=stop_reason)
            finally:
                await media.close()
        finally:
            await signaling.close()

    @staticmethod
    async def _send_json(conn: WebSocketConn, payload: dict) -> None:
        import json

        await conn.send(json.dumps(payload))

    @staticmethod
    async def _recv_json(conn: WebSocketConn) -> dict:
        import json

        raw = await conn.recv()
        if isinstance(raw, (bytes, bytearray)):
            raw = raw.decode("utf-8")
        return json.loads(raw)
