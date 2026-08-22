"""RtmsSession — drives one live Zoom RTMS stream from signaling handshake
to stream termination, accumulating audio bytes plus roster/speaker-label
data in memory.

`WebSocketConnector` is the swap point (CLAUDE.md rule 4): production wires
a real `websockets`-backed implementation, tests inject a fake that never
touches the network — same injection shape as `S3ClientBackend` in
adapters/blobstore_s3.py and `http_client` in capture/zoom_adapter.py.

Scope note: this accumulates one mixed audio stream, not per-participant
tracks — Zoom's per-participant binary framing (MEDIA_DATA_OPTION.AUDIO_
MULTI_STREAMS) is now *named* in a public source (rtms_protocol.py's
AUDIO_MULTI_STREAMS constant), but its exact per-frame shape isn't, so
requesting it would still mean guessing rather than honestly degrading
(docs/03-capture.md: "weaker modes yield honestly lower confidence, never
silent degradation"). Mixed-track is the same tier A2 already accepts for
Meet/Teams. This is docs/13-participant-identity-capture.md's "Option B";
this module implements "Option A" (participant/speaker *events*, which
carry names without needing per-participant audio framing at all).

Participant identity (Option A): PARTICIPANT_JOIN and ACTIVE_SPEAKER_CHANGE
events arrive as EVENT_UPDATE messages on the **signaling** connection, not
the media connection — confirmed by finding where Zoom's reference server
parses EVENT_SUBSCRIPTION (server/handlers/signalingHandler.js in
github.com/zoom/rtms-mock-server-sample). That means listening on both
connections concurrently, not just draining `media` after the initial
handshake as this module did before events existed. The event *content*
payload shape (which key holds a joining participant's name) is not
published anywhere reachable as of this writing — see rtms_protocol.py's
EVENT_TYPE constants' docstring — so `_extract_participant` below tries
several plausible shapes and logs the raw payload the first time none of
them match, rather than pretending certainty. This is meant to be
corrected once real production traffic shows the real shape, not treated
as finished.
"""

import asyncio
import contextlib
from dataclasses import dataclass, field
from typing import Protocol

import structlog

from app.capture.rtms_protocol import (
    DATA_HAND_SHAKE_RESP,
    EVENT_TYPE_ACTIVE_SPEAKER_CHANGE,
    EVENT_TYPE_PARTICIPANT_JOIN,
    EVENT_TYPE_PARTICIPANT_LEAVE,
    EVENT_UPDATE,
    KEEP_ALIVE_REQ,
    MEDIA_DATA_AUDIO,
    SIGNALING_HAND_SHAKE_RESP,
    STREAM_STATE_TERMINATED,
    STREAM_STATE_UPDATE,
    build_client_ready_ack,
    build_event_subscription,
    build_keep_alive_resp,
    build_media_handshake,
    build_signaling_handshake,
    parse_media_message,
)
from app.interfaces.platform import RosterEntry, SpeakerLabelSpan

log = structlog.get_logger()


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
    roster: list[RosterEntry] = field(default_factory=list)
    speaker_labels: list[SpeakerLabelSpan] = field(default_factory=list)


def _extract_participant(content: dict) -> tuple[str | None, str | None]:
    """Best-effort (user_id, user_name) from an EVENT_UPDATE's `content`,
    across several plausible shapes -- see this module's docstring for why
    the real shape isn't known with certainty yet. Returns (None, None)
    rather than raising on anything unrecognized; the caller logs that case
    once so the real shape can be read from production logs."""
    candidates = [content]
    participant = content.get("participant")
    if isinstance(participant, dict):
        candidates.append(participant)
    participants = content.get("participants")
    if isinstance(participants, list) and participants and isinstance(participants[0], dict):
        candidates.append(participants[0])

    user_id = user_name = None
    for candidate in candidates:
        user_id = user_id or candidate.get("user_id") or candidate.get("userId")
        user_name = user_name or candidate.get("user_name") or candidate.get("userName")
    return (str(user_id) if user_id is not None else None, user_name)


def _extract_timestamp_ms(content: dict) -> float | None:
    ts = content.get("timestamp")
    if ts is None:
        return None
    try:
        return float(ts)
    except (TypeError, ValueError):
        return None


@dataclass
class _EventTracker:
    """Turns the raw EVENT_UPDATE stream into RosterEntry/SpeakerLabelSpan
    rows. Active-speaker spans close when the next speaker change arrives,
    or at stream end via `close()` -- an interrupted last span is still
    better than dropping it (docs/03-capture.md: honest partial data, not
    silent loss).

    Timestamps: converts each event's own `timestamp` (assumed epoch
    milliseconds, matching KEEP_ALIVE_REQ's field elsewhere in this
    protocol -- not independently confirmed for events specifically) to
    seconds relative to `stream_start_ms`, the wall-clock time this session
    sent CLIENT_READY_ACK. Falls back to elapsed wall-clock time at receipt
    if an event carries no usable timestamp, so a span is never silently
    dropped for lack of one -- it's just less precise."""

    stream_start_ms: float
    unresolved_names: dict[str, str] = field(default_factory=dict)
    roster: list[RosterEntry] = field(default_factory=list)
    speaker_labels: list[SpeakerLabelSpan] = field(default_factory=list)
    _current_speaker: str | None = None
    _current_speaker_start_s: float | None = None
    _logged_unrecognized_shape: bool = False

    def _relative_seconds(self, content: dict) -> float:
        import time

        ts_ms = _extract_timestamp_ms(content)
        if ts_ms is not None:
            return max(0.0, (ts_ms - self.stream_start_ms) / 1000.0)
        return max(0.0, time.time() * 1000.0 - self.stream_start_ms) / 1000.0

    def handle(self, event_type: int, content: dict) -> None:
        user_id, user_name = _extract_participant(content)
        if user_id is None and user_name is None:
            if not self._logged_unrecognized_shape:
                log.warning(
                    "rtms.event_shape_unrecognized",
                    event_type=event_type,
                    content=content,
                )
                self._logged_unrecognized_shape = True
            return
        if user_name and user_id:
            self.unresolved_names[user_id] = user_name

        if event_type == EVENT_TYPE_PARTICIPANT_JOIN and user_name:
            self.roster.append(RosterEntry(display_name=user_name, platform_user_id=user_id))
        elif event_type == EVENT_TYPE_ACTIVE_SPEAKER_CHANGE:
            now_s = self._relative_seconds(content)
            display_name = user_name or self.unresolved_names.get(user_id or "")
            self._close_current_span(end_s=now_s)
            if display_name:
                self._current_speaker = display_name
                self._current_speaker_start_s = now_s
        elif event_type == EVENT_TYPE_PARTICIPANT_LEAVE:
            pass  # roster/labels stay -- a person who left still spoke earlier

    def _close_current_span(self, *, end_s: float) -> None:
        if (
            self._current_speaker is not None
            and self._current_speaker_start_s is not None
            and end_s > self._current_speaker_start_s
        ):
                self.speaker_labels.append(
                    SpeakerLabelSpan(
                        start_s=self._current_speaker_start_s,
                        end_s=end_s,
                        display_name=self._current_speaker,
                    )
                )
        self._current_speaker = None
        self._current_speaker_start_s = None

    def close(self, *, end_s: float) -> None:
        self._close_current_span(end_s=end_s)


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
        import time

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

            # Best-effort: a subscription rejection (e.g. events not
            # enabled for this account) must not take down audio capture,
            # which is the one thing this integration cannot degrade on.
            try:
                await self._send_json(
                    signaling,
                    build_event_subscription(
                        rtms_stream_id=rtms_stream_id,
                        event_types=[
                            EVENT_TYPE_PARTICIPANT_JOIN,
                            EVENT_TYPE_PARTICIPANT_LEAVE,
                            EVENT_TYPE_ACTIVE_SPEAKER_CHANGE,
                        ],
                    ),
                )
            except Exception as exc:
                log.warning("rtms.event_subscription_failed", error=str(exc))

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

                tracker = _EventTracker(stream_start_ms=time.time() * 1000.0)
                event_task = asyncio.create_task(self._signaling_event_loop(signaling, tracker))

                buffer = _Buffer()
                stop_reason: str | int | None = None
                try:
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
                            # instead of sending raw binary frames -- handle
                            # both shapes rather than assume only one is real.
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
                        # other control message types are ignored -- not
                        # needed for this audio-only, mixed-track slice.
                finally:
                    event_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await event_task
                    tracker.close(end_s=max(0.0, time.time() * 1000.0 - tracker.stream_start_ms) / 1000.0)

                return RtmsResult(
                    pcm_bytes=buffer.combined(),
                    stop_reason=stop_reason,
                    roster=tracker.roster,
                    speaker_labels=tracker.speaker_labels,
                )
            finally:
                await media.close()
        finally:
            await signaling.close()

    async def _signaling_event_loop(self, signaling: WebSocketConn, tracker: "_EventTracker") -> None:
        """Runs alongside the media loop for the lifetime of the stream,
        watching for EVENT_UPDATE messages. The media loop's
        STREAM_STATE_TERMINATED is what actually ends the session -- this
        loop is cancelled from the `finally` in `run()`, not by reaching a
        natural end itself, since EVENT_UPDATE messages don't include a
        signal for "no more events". Any error (including the fake test
        connector's queue running out) just ends the loop quietly: a lost
        event degrades identity confidence, it must never take down the
        audio capture this session exists to get."""
        while True:
            try:
                message = await self._recv_json(signaling)
            except Exception:
                return
            if message.get("msg_type") != EVENT_UPDATE:
                continue
            content = message.get("content", {})
            if not isinstance(content, dict):
                continue
            event_type = content.get("event_type", message.get("event_type"))
            if event_type is None:
                continue
            try:
                tracker.handle(int(event_type), content)
            except (TypeError, ValueError):
                continue

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
