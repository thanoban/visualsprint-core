"""Signature formula and message shapes verified against Zoom's own
reference implementation (github.com/zoom/rtms-mock-server-sample) -- these
are pinned constants, not arbitrary choices, so a change here should be
treated as a protocol regression, not a refactor."""

import hashlib
import hmac
import json

from app.capture.rtms_protocol import (
    CLIENT_READY_ACK,
    DATA_HAND_SHAKE_REQ,
    EVENT_SUBSCRIPTION,
    EVENT_TYPE_ACTIVE_SPEAKER_CHANGE,
    EVENT_TYPE_PARTICIPANT_JOIN,
    KEEP_ALIVE_RESP,
    MEDIA_TYPE_AUDIO,
    SIGNALING_HAND_SHAKE_REQ,
    build_client_ready_ack,
    build_event_subscription,
    build_keep_alive_resp,
    build_media_handshake,
    build_signaling_handshake,
    compute_signature,
    compute_webhook_validation_response,
    parse_media_message,
)


def test_compute_signature_matches_reference_formula():
    # signature = HMAC-SHA256(client_secret, f"{client_id},{meeting_uuid},{rtms_stream_id}")
    expected = hmac.new(
        b"secret123", b"client-abc,meeting-uuid-1,stream-1", hashlib.sha256
    ).hexdigest()

    assert compute_signature("client-abc", "meeting-uuid-1", "stream-1", "secret123") == expected


def test_build_signaling_handshake_shape():
    msg = build_signaling_handshake(
        client_id="cid", meeting_uuid="muid", rtms_stream_id="sid", client_secret="secret"
    )

    assert msg["msg_type"] == SIGNALING_HAND_SHAKE_REQ
    assert msg["protocol_version"] == 1
    assert msg["meeting_uuid"] == "muid"
    assert msg["rtms_stream_id"] == "sid"
    assert msg["signature"] == compute_signature("cid", "muid", "sid", "secret")


def test_build_media_handshake_shape():
    msg = build_media_handshake(
        client_id="cid", meeting_uuid="muid", rtms_stream_id="sid", client_secret="secret"
    )

    assert msg["msg_type"] == DATA_HAND_SHAKE_REQ
    assert msg["media_type"] == MEDIA_TYPE_AUDIO
    assert msg["payload_encryption"] is False
    assert msg["signature"] == compute_signature("cid", "muid", "sid", "secret")


def test_build_event_subscription_shape():
    msg = build_event_subscription(
        rtms_stream_id="sid",
        event_types=[EVENT_TYPE_PARTICIPANT_JOIN, EVENT_TYPE_ACTIVE_SPEAKER_CHANGE],
    )

    assert msg["msg_type"] == EVENT_SUBSCRIPTION
    assert msg["rtms_stream_id"] == "sid"
    assert msg["events"] == [
        {"event_type": EVENT_TYPE_PARTICIPANT_JOIN, "subscribe": True},
        {"event_type": EVENT_TYPE_ACTIVE_SPEAKER_CHANGE, "subscribe": True},
    ]


def test_build_client_ready_ack():
    msg = build_client_ready_ack(rtms_stream_id="sid")
    assert msg == {"msg_type": CLIENT_READY_ACK, "rtms_stream_id": "sid"}


def test_build_keep_alive_resp_echoes_timestamp():
    msg = build_keep_alive_resp(timestamp=12345)
    assert msg == {"msg_type": KEEP_ALIVE_RESP, "timestamp": 12345}


def test_parse_media_message_json_control_message():
    raw = json.dumps({"msg_type": 12, "timestamp": 1})
    message, audio = parse_media_message(raw)
    assert message == {"msg_type": 12, "timestamp": 1}
    assert audio is None


def test_parse_media_message_binary_audio_frame():
    raw = b"\x00\x01\x02\xff\xfe"  # not valid JSON/UTF-8 -- a real PCM frame
    message, audio = parse_media_message(raw)
    assert message is None
    assert audio == raw


def test_compute_webhook_validation_response():
    resp = compute_webhook_validation_response("plain-token-123", "webhook-secret")
    expected_hash = hmac.new(
        b"webhook-secret", b"plain-token-123", hashlib.sha256
    ).hexdigest()

    assert resp == {"plainToken": "plain-token-123", "encryptedToken": expected_hash}
