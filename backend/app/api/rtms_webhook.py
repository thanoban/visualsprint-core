"""Zoom RTMS webhook receiver — Mode A1's entry point.

Unlike every other capture mode, A1 is event-driven: Zoom tells us when a
stream starts and stops, rather than us polling for a finished artifact.
`meeting.rtms_started` kicks off a live WebSocket session (app/capture/
rtms_client.py) tracked in-process by rtms_stream_id; `meeting.rtms_stopped`
finalizes it into an AudioTrack and enqueues the `transcribe` stage
directly, bypassing the `acquire` PipelineJob stage entirely -- queue.py's
enqueue_stage takes an arbitrary stage string, nothing enforces acquire
running first.

In-process task tracking means a worker restart mid-stream loses that
session -- same maturity level as every other vendor path in this codebase,
which is all credential-unconfigured and untested against a live vendor.
"""

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.adapters.blobstore_s3 import get_blobstore
from app.capture.blob_ingest import pcm_to_flac_blob
from app.capture.consent import record_disclosure
from app.capture.rtms_client import RtmsResult, RtmsSession, WebSocketConnector
from app.capture.rtms_protocol import compute_webhook_validation_response
from app.config import get_settings
from app.db.base import get_db
from app.db.models import AudioTrack, CaptureSession, Meeting, Org
from app.orchestrator.queue import enqueue_stage

router = APIRouter(prefix="/api/v1/webhooks", tags=["rtms"])

# capture_session_id keyed by rtms_stream_id -- lets the rtms_stopped
# webhook find the session started by the earlier rtms_started webhook.
# In-process only; see module docstring.
_active_streams: dict[str, tuple[str, str, asyncio.Task]] = {}

_connector: WebSocketConnector | None = None


def set_websocket_connector(connector: WebSocketConnector | None) -> None:
    """Test/production seam -- no real `websockets` implementation is wired
    yet (no Zoom app registered), same as every other unconfigured vendor
    connector in this codebase. Tests inject a fake here."""
    global _connector
    _connector = connector


def _get_org_by_default(db: Session) -> Org:
    org = db.query(Org).filter(Org.name == "default").one_or_none()
    if org is None:
        org = Org(name="default")
        db.add(org)
        db.flush()
    return org


async def _run_stream(
    *, meeting_uuid: str, rtms_stream_id: str, signaling_url: str
) -> RtmsResult:
    if _connector is None:
        raise RuntimeError("no WebSocketConnector configured for RTMS -- Zoom app not registered yet")
    settings = get_settings()
    if not settings.zoom_client_id or not settings.zoom_client_secret:
        raise RuntimeError("Zoom RTMS client_id/client_secret not configured")
    session = RtmsSession(
        connector=_connector,
        client_id=settings.zoom_client_id,
        client_secret=settings.zoom_client_secret,
    )
    return await session.run(
        meeting_uuid=meeting_uuid, rtms_stream_id=rtms_stream_id, signaling_url=signaling_url
    )


@router.post("/zoom/rtms")
async def zoom_rtms_webhook(request: Request, db: Session = Depends(get_db)) -> dict:
    body = await request.json()
    event = body.get("event")
    payload = body.get("payload", {})

    if event == "endpoint.url_validation":
        settings = get_settings()
        if not settings.zoom_webhook_secret_token:
            raise HTTPException(500, "zoom_webhook_secret_token not configured")
        return compute_webhook_validation_response(
            payload["plainToken"], settings.zoom_webhook_secret_token
        )

    if event == "meeting.rtms_started":
        meeting_uuid = payload["meeting_uuid"]
        rtms_stream_id = payload["rtms_stream_id"]
        server_urls = payload["server_urls"]

        org = _get_org_by_default(db)
        meeting = (
            db.query(Meeting)
            .filter(Meeting.platform == "zoom", Meeting.platform_meeting_id == meeting_uuid)
            .one_or_none()
        )
        if meeting is None:
            meeting = Meeting(org_id=org.id, platform="zoom", platform_meeting_id=meeting_uuid)
            db.add(meeting)
            db.flush()

        session = CaptureSession(org_id=org.id, meeting_id=meeting.id, mode="A1")
        db.add(session)
        db.commit()

        task = asyncio.create_task(
            _run_stream(
                meeting_uuid=meeting_uuid, rtms_stream_id=rtms_stream_id, signaling_url=server_urls
            )
        )
        _active_streams[rtms_stream_id] = (org.id, session.id, task)
        return {"status": "accepted"}

    if event == "meeting.rtms_stopped":
        rtms_stream_id = payload["rtms_stream_id"]
        entry = _active_streams.pop(rtms_stream_id, None)
        if entry is None:
            raise HTTPException(404, f"no active RTMS stream for {rtms_stream_id!r}")
        org_id, session_id, task = entry

        result = await task
        session = db.get(CaptureSession, session_id)
        if session is None:
            raise HTTPException(404, "capture session not found")

        blob_uri = await pcm_to_flac_blob(
            result.pcm_bytes, get_blobstore(), f"zoom-rtms/{org_id}/{session_id}"
        )
        db.add(AudioTrack(org_id=org_id, capture_session_id=session.id, uri=blob_uri))

        record_disclosure(
            db,
            session,
            subject="all_participants",
            method="host_setting",
            detail=(
                "platform=zoom RTMS auto-enabled by org settings; disclosed to "
                "participants via Zoom's own in-meeting recording indicator — no bot "
                "in the room, per docs/03-capture.md"
            ),
        )

        enqueue_stage(db, org_id, session.id, "transcribe")
        db.commit()
        return {"status": "finalized", "capture_session_id": session.id}

    raise HTTPException(400, f"unhandled event {event!r}")
