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

Multi-tenant org routing: this one webhook endpoint receives events from
every Zoom account that's authorized VisualSprint's General OAuth App
(app/api/oauth.py, VS_ZOOM_OAUTH_CLIENT_ID -- separate from the RTMS
Server-to-Server app below), so `meeting.rtms_started` must resolve which
org each event belongs to via `_resolve_org_for_zoom_account` rather than
assuming a single account, as an earlier version of this file did (it
routed every webhook to one hardcoded "default" org, which only worked
because no second account had ever connected).
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
from app.db.models import AudioTrack, CaptureSession, Meeting, Org, OrgConnection
from app.orchestrator.pipeline import FIRST_STAGE, next_stage
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


def _resolve_org_for_zoom_account(db: Session, account_id: str | None) -> Org:
    """Maps an incoming webhook to the org that connected this Zoom
    account (app/api/oauth.py's Zoom callback stores the account_id as
    OrgConnection.external_id at connect time) -- one webhook endpoint is
    shared across every account that's authorized the app, with no other
    field to tell them apart.

    Falls back to the single "default" org when account_id is missing or
    doesn't match a connection: RTMS's exact webhook payload shape for
    account_id is not live-verified against a real Zoom webhook (no app
    is registered yet, same maturity level as every other vendor
    integration in this codebase, and public documentation on this
    specific field was inconsistent when checked) -- if that assumption
    turns out wrong, this must degrade to today's single-account behavior
    rather than silently misroute or crash a real capture."""
    if account_id:
        connection = (
            db.query(OrgConnection)
            .filter(OrgConnection.provider == "zoom", OrgConnection.external_id == account_id)
            .one_or_none()
        )
        if connection is not None:
            org = db.get(Org, connection.org_id)
            if org is not None:
                return org
    return _get_org_by_default(db)


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

        # account_id's presence/exact position in this specific payload is
        # unverified (see _resolve_org_for_zoom_account) -- .get(), never
        # [], so a wrong assumption here degrades to the old single-org
        # behavior instead of a 500 on every webhook.
        org = _resolve_org_for_zoom_account(db, payload.get("account_id"))
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

        # Derived from the pipeline graph (next_stage(FIRST_STAGE)), not a
        # hardcoded stage name -- RTMS writes its own AudioTrack directly
        # above (there's nothing to pull, so the "acquire" stage itself is
        # skipped), but still needs to enter at whatever stage comes right
        # after it. A literal string here was the actual gap: it read
        # "transcribe" from before the diarize stage existed and was never
        # updated when diarize was inserted into the chain, so a live Zoom
        # meeting silently got zero speaker separation while Mode D/A2 did
        # not. Deriving it from pipeline.py means the next stage-order
        # change can't cause the same class of bug again here.
        enqueue_stage(db, org_id, session.id, next_stage(FIRST_STAGE))
        db.commit()
        return {"status": "finalized", "capture_session_id": session.id}

    raise HTTPException(400, f"unhandled event {event!r}")
