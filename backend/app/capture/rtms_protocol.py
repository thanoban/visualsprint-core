"""Zoom RTMS wire protocol — message builders, parsers, the HMAC signature.

Pure and dependency-free: no network, no websockets import, so this is
testable without any live connection. Verified against Zoom's own public
reference implementation (github.com/zoom/rtms-mock-server-sample) rather
than invented from memory — the field names, msg_type values, and signature
formula below are quoted from that source, not guessed. Nothing here is
documented in this repo's own docs/03-capture.md, which only flags RTMS's
commercial terms as unconfirmed (a business blocker, separate from this
wire-protocol layer).
"""

import hmac
import json
from hashlib import sha256
from typing import Any

# RTMS_MESSAGE_TYPE, as named in Zoom's reference server.
SIGNALING_HAND_SHAKE_REQ = 1
SIGNALING_HAND_SHAKE_RESP = 2
DATA_HAND_SHAKE_REQ = 3
DATA_HAND_SHAKE_RESP = 4
EVENT_SUBSCRIPTION = 5
EVENT_UPDATE = 6
CLIENT_READY_ACK = 7
STREAM_STATE_UPDATE = 8
KEEP_ALIVE_REQ = 12
KEEP_ALIVE_RESP = 13
MEDIA_DATA_AUDIO = 14

# RTMS_EVENT_TYPE, quoted verbatim from Zoom's reference server
# (server/constants/messageTypes.js in github.com/zoom/rtms-mock-server-sample,
# fetched 2026-08-13 — same repo that grounded the constants above, not
# invented from memory). Values confirmed against this primary source;
# the *payload* shape of an EVENT_UPDATE carrying one of these is NOT
# published anywhere reachable as of this writing (Zoom's own data-types
# doc lists only the enum, no schema, and the mock server's public sample
# implements EVENT_SUBSCRIPTION handling but never actually emits
# PARTICIPANT_JOIN/ACTIVE_SPEAKER_CHANGE content to a client — see
# docs/13-participant-identity-capture.md). rtms_client.py's event handler
# is written defensively and logs the raw payload on first sight rather
# than guess field names, so the real shape gets learned from production
# traffic instead of assumed.
EVENT_TYPE_ACTIVE_SPEAKER_CHANGE = 2
EVENT_TYPE_PARTICIPANT_JOIN = 3
EVENT_TYPE_PARTICIPANT_LEAVE = 4

# MEDIA_DATA_TYPE.AUDIO bit value, used as `media_type` on the media handshake.
MEDIA_TYPE_AUDIO = 1

# MEDIA_DATA_OPTION, same source as RTMS_EVENT_TYPE above. Not used yet —
# this client only ever requests the default (mixed) stream — but named
# here so a future per-participant-stream implementation
# (docs/13-participant-identity-capture.md's "Option B") starts from a
# verified value instead of guessing one.
AUDIO_MIXED_STREAM = 1
AUDIO_MULTI_STREAMS = 2

# RTMS_STREAM_STATE.TERMINATED — what a STREAM_STATE_UPDATE reports at stream end.
STREAM_STATE_TERMINATED = 4


def compute_signature(client_id: str, meeting_uuid: str, rtms_stream_id: str, client_secret: str) -> str:
    """HMAC-SHA256(client_secret, "client_id,meeting_uuid,rtms_stream_id"), hex digest.
    Used identically for both the signaling and the media handshake."""
    message = f"{client_id},{meeting_uuid},{rtms_stream_id}"
    return hmac.new(client_secret.encode(), message.encode(), sha256).hexdigest()


def build_signaling_handshake(
    *, client_id: str, meeting_uuid: str, rtms_stream_id: str, client_secret: str
) -> dict[str, Any]:
    return {
        "msg_type": SIGNALING_HAND_SHAKE_REQ,
        "protocol_version": 1,
        "meeting_uuid": meeting_uuid,
        "rtms_stream_id": rtms_stream_id,
        "signature": compute_signature(client_id, meeting_uuid, rtms_stream_id, client_secret),
    }


def build_media_handshake(
    *, client_id: str, meeting_uuid: str, rtms_stream_id: str, client_secret: str
) -> dict[str, Any]:
    return {
        "msg_type": DATA_HAND_SHAKE_REQ,
        "protocol_version": 1,
        "meeting_uuid": meeting_uuid,
        "rtms_stream_id": rtms_stream_id,
        "signature": compute_signature(client_id, meeting_uuid, rtms_stream_id, client_secret),
        "media_type": MEDIA_TYPE_AUDIO,
        "payload_encryption": False,
    }


def build_event_subscription(
    *, rtms_stream_id: str, event_types: list[int]
) -> dict[str, Any]:
    """Opts into the given RTMS_EVENT_TYPE values on the signaling channel.

    Shape (`events: [{event_type, subscribe}]`) confirmed against
    `signalingHandler.js::handleEventSubscription` in Zoom's reference
    server, the same primary source as every other message builder in
    this module — see the constants' docstring above for exactly what is
    and isn't verified here."""
    return {
        "msg_type": EVENT_SUBSCRIPTION,
        "rtms_stream_id": rtms_stream_id,
        "events": [{"event_type": event_type, "subscribe": True} for event_type in event_types],
    }


def build_client_ready_ack(*, rtms_stream_id: str) -> dict[str, Any]:
    return {"msg_type": CLIENT_READY_ACK, "rtms_stream_id": rtms_stream_id}


def build_keep_alive_resp(*, timestamp: Any) -> dict[str, Any]:
    return {"msg_type": KEEP_ALIVE_RESP, "timestamp": timestamp}


def parse_media_message(raw: str | bytes) -> tuple[dict[str, Any] | None, bytes | None]:
    """Zoom's own client discriminates control vs. audio the same way: try
    JSON first, and if that fails the payload is a raw binary audio frame.
    Returns (json_message, None) or (None, raw_audio_bytes)."""
    if isinstance(raw, (bytes, bytearray)):
        try:
            return json.loads(raw.decode("utf-8")), None
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None, bytes(raw)
    try:
        return json.loads(raw), None
    except json.JSONDecodeError:
        return None, raw.encode("utf-8")


def compute_webhook_validation_response(plain_token: str, webhook_secret_token: str) -> dict[str, str]:
    """Zoom's endpoint.url_validation challenge-response: prove we hold the
    webhook secret without ever transmitting it."""
    encrypted_token = hmac.new(
        webhook_secret_token.encode(), plain_token.encode(), sha256
    ).hexdigest()
    return {"plainToken": plain_token, "encryptedToken": encrypted_token}


def compute_webhook_signature(raw_body: bytes, timestamp: str, webhook_secret_token: str) -> str:
    """Zoom's documented scheme for every webhook event AFTER the initial
    endpoint.url_validation handshake: v0=HMAC-SHA256("v0:{timestamp}:{raw_body}").
    Uses raw_body verbatim (not a re-serialized json.dumps) -- Zoom signs the
    exact bytes it sent, and re-serializing could reorder keys/whitespace and
    silently break every signature check."""
    message = f"v0:{timestamp}:{raw_body.decode('utf-8')}"
    digest = hmac.new(webhook_secret_token.encode(), message.encode(), sha256).hexdigest()
    return f"v0={digest}"


def verify_webhook_signature(
    raw_body: bytes, timestamp: str | None, signature: str | None, webhook_secret_token: str
) -> bool:
    """Rejects a forged webhook: without this, anyone who discovers the
    endpoint URL could POST a fake meeting.rtms_started and we'd start
    streaming/persisting a session that was never authorized by Zoom."""
    if not timestamp or not signature:
        return False
    expected = compute_webhook_signature(raw_body, timestamp, webhook_secret_token)
    return hmac.compare_digest(expected, signature)
