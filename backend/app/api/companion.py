"""Mode C companion-extension capture API.

The Chrome extension calls these endpoints during a live meeting:
  POST /sessions                                    — create session before recording
  POST /sessions/{capture_session_id}/chunks        — upload one 5-second WebM/Opus chunk
  POST /sessions/{capture_session_id}/keyframes     — upload one JPEG screenshot
  POST /sessions/{capture_session_id}/finalize      — assemble WAV, persist, enqueue pipeline
  GET  /escalations                                 — bot sessions stuck in the Meet lobby,
                                                        for the extension to offer as a
                                                        one-click Mode C fallback

Everything downstream of finalize is the standard pipeline (acquire → report).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import structlog
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.dependency import (
    get_current_user,
    require_org_member,
    require_session_member,
)
from app.db.base import get_db
from app.db.models import BotSession, BotStatus, CaptureSession, CaptureState, Meeting, User

log = structlog.get_logger()

router = APIRouter(
    prefix="/api/v1/orgs/{org_id}/companion",
    tags=["companion"],
)

MAX_CHUNK_BYTES = 10 * 1024 * 1024   # 10 MB per audio chunk
MAX_FRAME_BYTES = 2 * 1024 * 1024    # 2 MB per JPEG keyframe
MAX_CHUNKS = 3_600                    # 5 h at 5 s chunks

# A bot stuck in the lobby is only worth surfacing to the user while they
# might still be sitting in the meeting themselves -- past this window the
# meeting has likely ended or moved on without capture either way.
ESCALATION_WINDOW_MINUTES = 15


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class CompanionSessionRequest(BaseModel):
    title: str = Field(default="", max_length=500)
    meeting_url: str = Field(max_length=3000)
    platform: str = Field(default="meet", pattern="^(meet|zoom|teams)$")


class CompanionSessionResponse(BaseModel):
    session_id: str
    org_id: str


class CompanionFinalizeRequest(BaseModel):
    total_chunks: int = Field(ge=1, le=MAX_CHUNKS)
    roster: list[str] = Field(default_factory=list, max_length=500)
    microphone_captured: bool = True
    duration_s: float = Field(default=0, ge=0, le=5 * 3600)


class CompanionFinalizeResponse(BaseModel):
    capture_session_id: str
    enqueued: bool


class CompanionAbortRequest(BaseModel):
    error: str = Field(default="Capture could not start", max_length=1000)


class EscalationEntry(BaseModel):
    bot_session_id: str
    meeting_id: str | None
    join_url: str
    platform: str
    title: str
    lobby_timeout_at: str


class EscalationsResponse(BaseModel):
    escalations: list[EscalationEntry]


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/sessions", response_model=CompanionSessionResponse)
async def create_companion_session(
    org_id: str,
    body: CompanionSessionRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> CompanionSessionResponse:

    from app.adapters.calendar_common import detect_conferencing

    conferencing = detect_conferencing(body.meeting_url)
    if conferencing is None or conferencing[0] != body.platform:
        raise HTTPException(422, "meeting URL must match a supported meeting platform")

    meeting = Meeting(
        org_id=org_id,
        owner_user_id=user.id,
        title=body.title or "Companion recording",
        platform=body.platform,
        platform_meeting_id=conferencing[1],
    )
    db.add(meeting)
    db.flush()

    session = CaptureSession(org_id=org_id, meeting_id=meeting.id, mode="C")
    db.add(session)
    db.commit()
    db.refresh(session)

    log.info("companion.session.created", session_id=session.id, org_id=org_id,
             platform=body.platform)
    return CompanionSessionResponse(session_id=session.id, org_id=org_id)


@router.post("/sessions/{capture_session_id}/chunks")
async def upload_chunk(
    org_id: str,
    capture_session_id: str,
    seq: int = Form(...),
    data: UploadFile = File(...),
    db: Session = Depends(get_db),
    session: CaptureSession = Depends(require_session_member),
) -> dict[str, object]:
    if session.org_id != org_id:
        raise HTTPException(404, "capture session not found in this org")
    if session.mode != "C":
        raise HTTPException(400, "not a companion session")
    if session.state != CaptureState.SCHEDULED:
        raise HTTPException(409, "capture session no longer accepts uploads")
    if seq < 0 or seq >= MAX_CHUNKS:
        raise HTTPException(400, f"seq out of range [0, {MAX_CHUNKS}]")

    chunk_bytes = await data.read(MAX_CHUNK_BYTES + 1)
    if len(chunk_bytes) > MAX_CHUNK_BYTES:
        raise HTTPException(413, "chunk exceeds 10 MB limit")
    if not chunk_bytes:
        raise HTTPException(400, "empty chunk")

    # Auth validated — release the DB connection before the GCS upload so we
    # don't hold a pool slot during network I/O. Cloud Run's default concurrency
    # is 80; with pool_size=3, holding a connection across a multi-second GCS
    # write makes the 4th concurrent request time out after 30 s. The finally
    # block in get_db() will call close() again, which is a safe no-op.
    db.close()

    from app.adapters.blobstore_s3 import get_blobstore
    blob_store = get_blobstore()
    key = f"companion-chunks/{org_id}/{capture_session_id}/{seq:06d}.webm"
    await blob_store.put(key, chunk_bytes, content_type="audio/webm")

    log.debug("companion.chunk.stored", session_id=capture_session_id, seq=seq,
              size_bytes=len(chunk_bytes))
    return {"seq": seq, "stored": True}


@router.post("/sessions/{capture_session_id}/keyframes")
async def upload_keyframe(
    org_id: str,
    capture_session_id: str,
    seq: int = Form(...),
    timestamp_s: float = Form(...),
    data: UploadFile = File(...),
    db: Session = Depends(get_db),
    session: CaptureSession = Depends(require_session_member),
) -> dict[str, object]:
    if session.org_id != org_id:
        raise HTTPException(404, "capture session not found in this org")
    if session.mode != "C":
        raise HTTPException(400, "not a companion session")

    import math

    if session.state != CaptureState.SCHEDULED:
        raise HTTPException(409, "capture session no longer accepts uploads")
    if seq < 0 or seq >= 1800 or not math.isfinite(timestamp_s) or not 0 <= timestamp_s <= 18000:
        raise HTTPException(422, "invalid keyframe sequence or timestamp")
    frame_bytes = await data.read(MAX_FRAME_BYTES + 1)
    if len(frame_bytes) > MAX_FRAME_BYTES:
        raise HTTPException(413, "keyframe exceeds 2 MB limit")
    if not frame_bytes:
        raise HTTPException(400, "empty keyframe")

    from app.adapters.blobstore_s3 import get_blobstore
    from app.db.models import Keyframe
    blob_store = get_blobstore()
    key = f"companion-frames/{org_id}/{capture_session_id}/{seq:06d}.jpg"

    # Release the DB connection before the GCS upload; SQLAlchemy will
    # reconnect automatically when we call db.add() below.
    db.close()

    image_uri = await blob_store.put(key, frame_bytes, content_type="image/jpeg")

    # valid_to_s is a 30s estimate; the screen stage refines it with OCR timing.
    # Stable primary key makes keyframe retries idempotent across replicas.
    from uuid import NAMESPACE_URL, uuid5

    frame_id = str(uuid5(NAMESPACE_URL, f"visualsprint:{capture_session_id}:frame:{seq}"))
    db.merge(Keyframe(
        id=frame_id,
        org_id=org_id,
        capture_session_id=capture_session_id,
        valid_from_s=timestamp_s,
        valid_to_s=timestamp_s + 30.0,
        image_uri=image_uri,
    ))
    db.commit()

    log.debug("companion.keyframe.stored", session_id=capture_session_id, seq=seq,
              timestamp_s=timestamp_s)
    return {"seq": seq, "stored": True}


@router.post("/sessions/{capture_session_id}/finalize",
             response_model=CompanionFinalizeResponse)
async def finalize_session(
    org_id: str,
    capture_session_id: str,
    body: CompanionFinalizeRequest,
    db: Session = Depends(get_db),
    session: CaptureSession = Depends(require_session_member),
) -> CompanionFinalizeResponse:
    if session.org_id != org_id:
        raise HTTPException(404, "capture session not found in this org")
    if session.mode != "C":
        raise HTTPException(400, "not a companion session")
    # Small immutable manifest + durable queue job. No ffmpeg/network download
    # in the HTTP request; the acquire worker can retry after a crash.
    import json

    from sqlalchemy import select

    from app.adapters.blobstore_s3 import get_blobstore
    from app.orchestrator.queue import enqueue_pipeline

    session = db.execute(
        select(CaptureSession).where(
            CaptureSession.id == capture_session_id,
            CaptureSession.org_id == org_id,
        ).with_for_update()
    ).scalar_one()
    if session.state == CaptureState.FAILED:
        raise HTTPException(409, session.error or "capture failed")
    if session.state != CaptureState.SCHEDULED:
        return CompanionFinalizeResponse(capture_session_id=capture_session_id, enqueued=True)

    manifest = body.model_dump()
    await get_blobstore().put(
        f"companion-manifests/{org_id}/{capture_session_id}.json",
        json.dumps(manifest).encode(), content_type="application/json",
    )
    session.state = CaptureState.ACQUIRING
    enqueue_pipeline(db, org_id, session.id)
    db.commit()
    log.info("companion.finalize.queued", session_id=capture_session_id,
             total_chunks=body.total_chunks)
    return CompanionFinalizeResponse(capture_session_id=capture_session_id, enqueued=True)


@router.post("/sessions/{capture_session_id}/abort")
async def abort_session(
    org_id: str,
    capture_session_id: str,
    body: CompanionAbortRequest,
    db: Session = Depends(get_db),
    session: CaptureSession = Depends(require_session_member),
) -> dict[str, bool]:
    if session.org_id != org_id:
        raise HTTPException(404, "capture session not found in this org")
    if session.mode != "C":
        raise HTTPException(400, "not a companion session")
    from app.db.models import CoverageInterval, CoverageStatus

    if session.state == CaptureState.SCHEDULED:
        session.state = CaptureState.FAILED
        session.error = body.error
        db.add(CoverageInterval(
            org_id=org_id, capture_session_id=session.id, start_s=0, end_s=0,
            modality="audio", status=CoverageStatus.MISSING, reason=body.error,
        ))
        db.commit()
    return {"aborted": session.state == CaptureState.FAILED}


@router.get("/escalations", response_model=EscalationsResponse)
async def list_escalations(
    org_id: str,
    db: Session = Depends(get_db),
    _: None = Depends(require_org_member),
) -> EscalationsResponse:
    """Bot sessions that never got past the Meet/Zoom/Teams lobby, recent
    enough that the user is plausibly still sitting in the meeting. The
    extension polls this and offers a one-click Mode C fallback -- the
    "Smart Capture Router" handoff from Mode B to Mode C."""
    cutoff = datetime.now(UTC) - timedelta(minutes=ESCALATION_WINDOW_MINUTES)

    rows = (
        db.query(BotSession, Meeting)
        .outerjoin(Meeting, BotSession.meeting_id == Meeting.id)
        .filter(
            BotSession.org_id == org_id,
            BotSession.status == BotStatus.LOBBY_TIMEOUT,
            BotSession.lobby_timeout_at.isnot(None),
            BotSession.lobby_timeout_at >= cutoff,
        )
        .order_by(BotSession.lobby_timeout_at.desc())
        .all()
    )

    escalations = [
        EscalationEntry(
            bot_session_id=bot.id,
            meeting_id=bot.meeting_id,
            join_url=bot.join_url,
            platform=bot.platform,
            title=(meeting.title if meeting else "") or "Meeting",
            lobby_timeout_at=bot.lobby_timeout_at.isoformat(),
        )
        for bot, meeting in rows
    ]
    return EscalationsResponse(escalations=escalations)
