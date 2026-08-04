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
CLIENT_READY_ACK = 7
STREAM_STATE_UPDATE = 8
KEEP_ALIVE_REQ = 12
KEEP_ALIVE_RESP = 13
MEDIA_DATA_AUDIO = 14

# MEDIA_DATA_TYPE.AUDIO bit value, used as `media_type` on the media handshake.
MEDIA_TYPE_AUDIO = 1

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
