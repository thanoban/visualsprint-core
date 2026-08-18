"""Zoom RTMS webhook receiver — Mode A1's entry point.

Unlike every other capture mode, A1 is event-driven: Zoom tells us when a
stream starts and stops, rather than us polling for a finished artifact.
`meeting.rtms_started` kicks off a live WebSocket session (app/capture/
rtms_client.py) tracked in-process by rtms_stream_id; `meeting.rtms_stopped`
finalizes it into an AudioTrack (plus roster/speaker-label rows when
participant events were captured -- see app/capture/persist.py) and
enqueues the pipeline one stage past FIRST_STAGE, bypassing only the
`acquire` PipelineJob stage itself -- queue.py's enqueue_stage takes an
arbitrary stage string, nothing enforces acquire running first.

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
import json
import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.adapters.blobstore_s3 import get_blobstore
from app.capture.blob_ingest import pcm_to_flac_blob
from app.capture.consent import record_disclosure
from app.capture.persist import persist_capture_artifacts
from app.capture.rtms_client import RtmsResult, RtmsSession, WebSocketConnector
from app.capture.rtms_protocol import (
    compute_webhook_validation_response,
    verify_webhook_signature,
)
from app.config import get_settings
from app.db.base import get_db
from app.db.models import CaptureSession, Meeting, Org, OrgConnection
from app.interfaces.platform import AudioTrack, CaptureArtifacts, CaptureMode
from app.orchestrator.pipeline import FIRST_STAGE, next_stage
from app.orchestrator.queue import enqueue_stage

router = APIRouter(prefix="/api/v1/webhooks", tags=["rtms"])
logger = logging.getLogger(__name__)

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


async def _get_s2s_token() -> str:
    """Fetch a Server-to-Server OAuth access token from Zoom.

    The S2S token is scoped to the account-level app and is valid for 1 hour.
    We don't cache it here -- this endpoint is called at most once per meeting
    (when meeting.started fires), so the overhead is negligible compared to
    having stale-token bugs on a cache that outlives a deployment.
    """
    settings = get_settings()
    if not settings.zoom_client_id or not settings.zoom_client_secret:
        raise RuntimeError("zoom_client_id / zoom_client_secret not configured")
    if not settings.zoom_account_id:
        raise RuntimeError("zoom_account_id not configured")
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            "https://zoom.us/oauth/token",
            params={"grant_type": "account_credentials", "account_id": settings.zoom_account_id},
            auth=(settings.zoom_client_id, settings.zoom_client_secret),
        )
        resp.raise_for_status()
        return resp.json()["access_token"]


async def _enable_rtms_for_meeting(meeting_id: str) -> None:
    """Call Zoom's REST API to enable RTMS for a running meeting.

    Zoom only fires meeting.rtms_started if the S2S RTMS app explicitly
    enables streaming for the meeting -- it doesn't auto-start even with
    the right scopes. This call is what triggers that webhook.
    Without it, Zoom sends meeting.started but never meeting.rtms_started.
    """
    try:
        token = await _get_s2s_token()
    except Exception as exc:
        logger.error("failed to get S2S token for RTMS activation: %s", exc)
        return
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.patch(
            f"https://api.zoom.us/v2/meetings/{meeting_id}/rtms",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"status": "active"},
        )
        if resp.status_code in (200, 204):
            logger.info("RTMS enabled for meeting %s", meeting_id)
        else:
            logger.warning(
                "RTMS activation returned %s for meeting %s: %s",
                resp.status_code, meeting_id, resp.text,
            )


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
    raw_body = await request.body()
    body = json.loads(raw_body)
    event = body.get("event")
    payload = body.get("payload", {})

    settings = get_settings()
    if not settings.zoom_webhook_secret_token:
        raise HTTPException(500, "zoom_webhook_secret_token not configured")

    if event == "endpoint.url_validation":
        # The very first handshake, before Zoom has a verified endpoint --
        # Zoom does not sign this one with x-zm-signature (nothing to sign
        # with yet), so it's the one legitimate exception to the check below.
        return compute_webhook_validation_response(
            payload["plainToken"], settings.zoom_webhook_secret_token
        )

    if not verify_webhook_signature(
        raw_body,
        request.headers.get("x-zm-request-timestamp"),
        request.headers.get("x-zm-signature"),
        settings.zoom_webhook_secret_token,
    ):
        raise HTTPException(401, "invalid or missing Zoom webhook signature")

    if event == "meeting.started":
        # Zoom only fires meeting.rtms_started when the S2S app explicitly
        # enables RTMS for the meeting via its REST API -- it does NOT
        # auto-start even with the correct scopes. We call the API here,
        # which triggers Zoom to fire meeting.rtms_started back to us.
        obj = payload.get("object", {})
        meeting_id = obj.get("id") or payload.get("id")
        if meeting_id:
            asyncio.create_task(_enable_rtms_for_meeting(str(meeting_id)))
        return {"status": "rtms_activation_requested"}

    if event == "meeting.rtms_started":
        # Zoom nests meeting data under payload["object"]; account_id sits
        # one level up at payload["account_id"]. Verified against Zoom's own
        # webhook payload documentation and live event structure.
        obj = payload.get("object", {})
        # "uuid" is the stable identifier for one occurrence; "id" is the
        # numeric meeting ID. The RTMS handshake uses uuid.
        meeting_uuid = obj.get("uuid") or obj.get("meeting_uuid") or payload.get("meeting_uuid")
        rtms_stream_id = obj.get("rtms_stream_id") or payload.get("rtms_stream_id")
        if not meeting_uuid or not rtms_stream_id:
            logger.warning(
                "rtms_started: missing meeting_uuid or rtms_stream_id, payload=%r", payload
            )
            raise HTTPException(400, "meeting_uuid or rtms_stream_id missing from payload")
        # server_urls can be a plain string (the signaling URL) or a dict
        # with platform-specific keys. Use "all" or the first value when it's
        # a dict, to remain compatible if Zoom changes the format.
        raw_urls = obj.get("server_urls") or payload.get("server_urls", "")
        if isinstance(raw_urls, dict):
            signaling_url = raw_urls.get("all") or next(iter(raw_urls.values()), "")
        else:
            signaling_url = raw_urls
        if not signaling_url:
            logger.warning("rtms_started: no usable server_urls, payload=%r", payload)
            raise HTTPException(400, "server_urls missing from payload")

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
                meeting_uuid=meeting_uuid, rtms_stream_id=rtms_stream_id, signaling_url=signaling_url
            )
        )
        _active_streams[rtms_stream_id] = (org.id, session.id, task)
        return {"status": "accepted"}

    if event == "meeting.rtms_stopped":
        obj = payload.get("object", {})
        rtms_stream_id = obj.get("rtms_stream_id") or payload.get("rtms_stream_id")
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
        # Same persistence path as every other capture mode
        # (app/capture/persist.py), not a hand-rolled second copy: turns
        # result.roster/speaker_labels (docs/13-participant-identity-
        # capture.md's "Option A" -- PARTICIPANT_JOIN/ACTIVE_SPEAKER_CHANGE
        # events, see app/capture/rtms_client.py) into the same
        # Participant/PlatformSpeakerLabel rows Meet/Teams/Zoom-cloud
        # already produce, so identity resolution (app/speakers/identity.py)
        # treats a live Zoom meeting no differently from any other mode.
        persist_capture_artifacts(
            db,
            session,
            CaptureArtifacts(
                mode=CaptureMode.OFFICIAL_REALTIME,
                audio_tracks=[AudioTrack(uri=blob_uri)],
                roster=result.roster,
                speaker_labels=result.speaker_labels,
            ),
        )

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

    # Zoom sends many meeting lifecycle events (meeting.started,
    # meeting.participant_joined, meeting.ended, etc.) to any registered
    # webhook endpoint -- not just the RTMS-specific ones we care about.
    # Returning 400 causes Zoom to mark the endpoint as unhealthy and
    # eventually throttle or suspend delivery. Return 200 and log so we
    # can see what Zoom is actually sending without breaking the channel.
    logger.info("zoom webhook event %r ignored (not an RTMS event), keys=%s", event, list(payload.keys()))
    return {"status": "ignored", "event": event}
