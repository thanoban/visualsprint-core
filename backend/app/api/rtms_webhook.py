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
from typing import Any, Callable

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.adapters.blobstore_s3 import get_blobstore
from app.capture.blob_ingest import pcm_to_flac_blob
from app.capture.consent import record_disclosure
from app.capture.persist import persist_capture_artifacts
from app.capture.rtms_client import RtmsResult, RtmsSession, WebSocketConnector
from app.capture.token_provider import TokenProvider
from app.capture.rtms_protocol import (
    compute_webhook_validation_response,
    verify_webhook_signature,
)
from app.config import get_settings
from app.db.base import get_db
from app.db.models import (
    CaptureSession,
    CaptureState,
    CoverageInterval,
    CoverageStatus,
    Meeting,
    Org,
    OrgConnection,
)
from app.interfaces.platform import AudioTrack, CaptureArtifacts, CaptureMode
from app.orchestrator.pipeline import FIRST_STAGE, next_stage
from app.orchestrator.queue import enqueue_stage

router = APIRouter(prefix="/api/v1/webhooks", tags=["rtms"])
logger = logging.getLogger(__name__)

# capture_session_id keyed by rtms_stream_id -- lets the rtms_stopped
# webhook find the session started by the earlier rtms_started webhook.
# In-process only; see module docstring.
_active_streams: dict[str, tuple[str, str, "asyncio.Task[RtmsResult]"]] = {}

_connector: WebSocketConnector | None = None


def set_websocket_connector(connector: WebSocketConnector | None) -> None:
    """Test/production seam -- no real `websockets` implementation is wired
    yet (no Zoom app registered), same as every other unconfigured vendor
    connector in this codebase. Tests inject a fake here."""
    global _connector
    _connector = connector


def _resolve_org_for_zoom_account(db: Session, account_id: str | None) -> Org:
    """Maps an incoming webhook to the org that connected this Zoom account.

    Raises 404 when the account_id is missing or doesn't match any connected
    org -- there is no correct default tenant. Routing to a "default" org
    would mix unrelated tenants' meeting data, which is a data breach.
    """
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
    raise HTTPException(
        404,
        f"No org has connected Zoom account {account_id!r}. "
        "Connect it via Settings → Integrations → Zoom.",
    )


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
        return str(resp.json()["access_token"])


async def _enable_rtms_for_meeting(meeting_id: str, token_provider: TokenProvider | None = None) -> None:
    """Current Zoom RTMS REST contract; account-matched credentials only."""
    settings = get_settings()
    token = await token_provider.get_token() if token_provider else await _get_s2s_token()
    client_id = settings.zoom_oauth_client_id if token_provider else settings.zoom_client_id
    if not client_id:
        raise RuntimeError("RTMS app client ID is not configured")
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.patch(
            f"https://api.zoom.us/v2/live_meetings/{meeting_id}/rtms_app/status",
            headers={"Authorization": f"Bearer {token}"},
            json={"action": "start", "settings": {"client_id": client_id}},
        )
        response.raise_for_status()
    logger.info("RTMS activation accepted for meeting %s; awaiting stream-start event", meeting_id)


async def _run_stream(
    *, meeting_uuid: str, rtms_stream_id: str, signaling_url: str
) -> RtmsResult:
    if _connector is None:
        raise RuntimeError("no WebSocketConnector configured for RTMS -- Zoom app not registered yet")
    settings = get_settings()
    client_id = settings.zoom_oauth_client_id or settings.zoom_client_id
    client_secret = settings.zoom_oauth_client_secret or settings.zoom_client_secret
    if not client_id or not client_secret:
        raise RuntimeError("Zoom RTMS client_id/client_secret not configured")
    session = RtmsSession(
        connector=_connector,
        client_id=client_id,
        client_secret=client_secret,
    )
    return await session.run(
        meeting_uuid=meeting_uuid, rtms_stream_id=rtms_stream_id, signaling_url=signaling_url
    )


async def _persist_rtms_result(db: Session, org_id: str, session_id: str, result: RtmsResult) -> None:
    blob_uri = await pcm_to_flac_blob(
        result.pcm_bytes, get_blobstore(), f"zoom-rtms/{org_id}/{session_id}"
    )

    session = db.query(CaptureSession).filter(CaptureSession.id == session_id).with_for_update().one_or_none()
    if session is None:
        raise HTTPException(404, "capture session not found")

    if session.state not in (CaptureState.SCHEDULED, CaptureState.ACQUIRING):
        return

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
    second_stage = next_stage(FIRST_STAGE)
    assert second_stage is not None, "pipeline must have a stage after FIRST_STAGE"
    enqueue_stage(db, org_id, session.id, second_stage)
    session.state = CaptureState.ACQUIRED
    db.commit()


async def _run_owned_stream(*, org_id: str, session_id: str, db_factory: Callable[[], Session],
                            meeting_uuid: str, rtms_stream_id: str, signaling_url: str) -> RtmsResult:
    result = await _run_stream(meeting_uuid=meeting_uuid, rtms_stream_id=rtms_stream_id,
                               signaling_url=signaling_url)
    with db_factory() as owned_db:
        await _persist_rtms_result(owned_db, org_id, session_id, result)
    return result


@router.post("/zoom/rtms")
async def zoom_rtms_webhook(
    request: Request,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    # db is released early (db.close()) on every branch that does not need the
    # DB so we don't hold a pool slot during the many Zoom lifecycle events that
    # require no persistence. For rtms_started / rtms_stopped the session is
    # kept open and returned to the pool by get_db()'s finally block at the end
    # of the request. The Depends(get_db) approach (vs. manual get_sessionmaker())
    # makes test's dependency_overrides work correctly.
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
        db.close()
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
        from app.oauth.connection import build_org_token_provider

        org = _resolve_org_for_zoom_account(db, payload.get("account_id"))
        tokens = build_org_token_provider(db, org.id, "zoom")
        # A developer S2S app has authority for only its own account. Never use
        # it to activate another customer's meeting.
        if tokens is None and payload.get("account_id") != settings.zoom_account_id:
            raise HTTPException(409, "Reconnect Zoom with RTMS permissions for this account")
        obj = payload.get("object", {})
        meeting_id = obj.get("id") or payload.get("id")
        if not meeting_id:
            raise HTTPException(400, "meeting ID missing from payload")
        db.close()
        background_tasks.add_task(_enable_rtms_for_meeting, str(meeting_id), tokens)
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
        existing = db.query(CaptureSession).filter(
            CaptureSession.org_id == org.id, CaptureSession.rtms_stream_id == rtms_stream_id
        ).first()
        if existing is not None:
            return {"status": "duplicate", "capture_session_id": existing.id}
        meeting = (
            db.query(Meeting)
            .filter(Meeting.org_id == org.id, Meeting.platform == "zoom", Meeting.platform_meeting_id == meeting_uuid)
            .one_or_none()
        )
        if meeting is None:
            meeting = Meeting(org_id=org.id, platform="zoom", platform_meeting_id=meeting_uuid)
            db.add(meeting)
            db.flush()

        cap_session = CaptureSession(
            org_id=org.id, meeting_id=meeting.id, mode="A1", rtms_stream_id=rtms_stream_id
        )
        db.add(cap_session)
        db.commit()

        from sqlalchemy.orm import sessionmaker

        task = asyncio.create_task(
            _run_owned_stream(
                org_id=org.id, session_id=cap_session.id,
                db_factory=sessionmaker(bind=db.get_bind(), expire_on_commit=False),
                meeting_uuid=meeting_uuid, rtms_stream_id=rtms_stream_id, signaling_url=signaling_url
            )
        )
        _active_streams[rtms_stream_id] = (org.id, cap_session.id, task)
        return {"status": "accepted"}

    if event == "meeting.rtms_stopped":
        obj = payload.get("object", {})
        rtms_stream_id = obj.get("rtms_stream_id") or payload.get("rtms_stream_id")
        entry = _active_streams.pop(rtms_stream_id, None)
        if entry is None:
            # The stop webhook may land on another replica, or be a retry.
            # Never turn a load-balancing event into an unknown capture.
            session = db.query(CaptureSession).filter(
                CaptureSession.rtms_stream_id == rtms_stream_id
            ).first()
            if session is None:
                raise HTTPException(404, f"no active RTMS stream for {rtms_stream_id!r}")
            if session.state not in (CaptureState.SCHEDULED, CaptureState.ACQUIRING):
                return {"status": "finalized", "capture_session_id": session.id}
            return {"status": "awaiting_stream_owner", "capture_session_id": session.id}
        org_id, session_id, task = entry

        try:
            await task
        except Exception as exc:  # noqa: BLE001
            # The WebSocket stream failed (network error, corrupt PCM, etc.).
            # The entry was already popped from _active_streams above, so any
            # Zoom retry of this stop event would hit the 404 branch and discard
            # the audio twice. Return 200 so Zoom does not retry; write a
            # CoverageInterval gap row to disclose the loss (CLAUDE.md rule 6).
            logger.exception(
                "zoom RTMS stream task failed; audio lost for session=%s stream=%s",
                session_id,
                rtms_stream_id,
                exc_info=exc,
            )
            session = db.get(CaptureSession, session_id)
            if session is not None:
                session.state = CaptureState.FAILED
                db.add(
                    CoverageInterval(
                        org_id=org_id,
                        capture_session_id=session_id,
                        start_s=0.0,
                        end_s=0.0,
                        modality="audio",
                        status=CoverageStatus.MISSING,
                        reason=f"RTMS stream task failed: {exc!r}"[:500],
                    )
                )
                db.commit()
            return {"status": "stream_failed", "capture_session_id": session_id}

        # The stream owner finalizes on WebSocket termination even when the
        # stop webhook arrives on another API replica.

        return {"status": "finalized", "capture_session_id": session_id}

    # Zoom sends many meeting lifecycle events (meeting.started,
    # meeting.participant_joined, meeting.ended, etc.) to any registered
    # webhook endpoint -- not just the RTMS-specific ones we care about.
    # Returning 400 causes Zoom to mark the endpoint as unhealthy and
    # eventually throttle or suspend delivery. Return 200 and log so we
    # can see what Zoom is actually sending without breaking the channel.
    db.close()
    logger.info("zoom webhook event %r ignored (not an RTMS event), keys=%s", event, list(payload.keys()))
    return {"status": "ignored", "event": event}
