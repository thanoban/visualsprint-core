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
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth.dependency import (
    get_current_user,
    is_org_member,
    require_org_member,
    require_session_member,
)
from app.db.base import get_db
from app.db.models import BotSession, BotStatus, CaptureSession, Meeting, User

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
    title: str = ""
    meeting_url: str = ""
    platform: str = "meet"   # meet | zoom | teams


class CompanionSessionResponse(BaseModel):
    session_id: str
    org_id: str


class CompanionFinalizeRequest(BaseModel):
    total_chunks: int
    roster: list[str] = []


class CompanionFinalizeResponse(BaseModel):
    capture_session_id: str
    enqueued: bool


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
) -> CompanionSessionResponse:
    if not is_org_member(db, org_id, user):
        raise HTTPException(status_code=403, detail="not a member of this organisation")

    meeting = Meeting(
        org_id=org_id,
        title=body.title or "Companion recording",
        platform=body.platform,
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
    if session.mode != "C":
        raise HTTPException(400, "not a companion session")
    if seq < 0 or seq > MAX_CHUNKS:
        raise HTTPException(400, f"seq out of range [0, {MAX_CHUNKS}]")

    chunk_bytes = await data.read(MAX_CHUNK_BYTES + 1)
    if len(chunk_bytes) > MAX_CHUNK_BYTES:
        raise HTTPException(413, "chunk exceeds 10 MB limit")
    if not chunk_bytes:
        raise HTTPException(400, "empty chunk")

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
    if session.mode != "C":
        raise HTTPException(400, "not a companion session")

    frame_bytes = await data.read(MAX_FRAME_BYTES + 1)
    if len(frame_bytes) > MAX_FRAME_BYTES:
        raise HTTPException(413, "keyframe exceeds 2 MB limit")
    if not frame_bytes:
        raise HTTPException(400, "empty keyframe")

    from app.adapters.blobstore_s3 import get_blobstore
    from app.db.models import Keyframe
    blob_store = get_blobstore()
    key = f"companion-frames/{org_id}/{capture_session_id}/{seq:06d}.jpg"
    image_uri = await blob_store.put(key, frame_bytes, content_type="image/jpeg")

    # valid_to_s is a 30s estimate; the screen stage refines it with OCR timing.
    db.add(Keyframe(
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
    if session.mode != "C":
        raise HTTPException(400, "not a companion session")
    if body.total_chunks < 1:
        raise HTTPException(400, "total_chunks must be >= 1")

    from sqlalchemy import select

    from app.adapters.blobstore_s3 import get_blobstore
    from app.capture.audio_utils import webm_chunks_to_wav
    from app.capture.consent import record_disclosure
    from app.capture.persist import persist_capture_artifacts
    from app.db.models import CaptureState, Keyframe
    from app.interfaces.platform import (
        AudioTrack,
        CaptureArtifacts,
        CaptureMode,
        PreExtractedFrame,
        RosterEntry,
    )
    from app.orchestrator.queue import enqueue_pipeline

    blob_store = get_blobstore()

    # Collect uploaded chunks; allow partial sets (tab closed early — partial
    # captures with disclosed gaps are better than nothing).
    chunks: list[bytes] = []
    missing: list[int] = []
    for i in range(body.total_chunks):
        uri = f"blob://companion-chunks/{org_id}/{capture_session_id}/{i:06d}.webm"
        if not await blob_store.exists(uri):
            missing.append(i)
            continue
        chunks.append(await blob_store.get(uri))

    if missing:
        log.warning("companion.finalize.missing_chunks", session_id=capture_session_id,
                    count=len(missing), first_few=missing[:10])
    if not chunks:
        raise HTTPException(422, "no audio chunks found — nothing to finalize")

    wav_bytes = webm_chunks_to_wav(chunks)
    if not wav_bytes:
        raise HTTPException(
            500,
            "audio transcode failed — ffmpeg unavailable or chunk data corrupt",
        )

    audio_uri = await blob_store.put(
        f"companion-audio/{org_id}/{capture_session_id}.wav",
        wav_bytes,
        content_type="audio/wav",
    )

    # Keyframe rows were already written incrementally by upload_keyframe.
    existing_frames = (
        db.execute(
            select(Keyframe)
            .where(Keyframe.capture_session_id == capture_session_id)
            .order_by(Keyframe.valid_from_s)
        ).scalars().all()
    )
    preextracted = [
        PreExtractedFrame(image_uri=f.image_uri, timestamp_s=f.valid_from_s)
        for f in existing_frames
    ]

    roster = [RosterEntry(display_name=name) for name in body.roster if name.strip()]

    artifacts = CaptureArtifacts(
        mode=CaptureMode.DESKTOP,
        audio_tracks=[AudioTrack(uri=audio_uri, participant=None)],
        roster=roster,
        preextracted_keyframes=preextracted,
    )
    persist_capture_artifacts(db, session, artifacts)
    record_disclosure(
        db,
        session,
        subject="all_participants",
        method="companion_extension",
        detail=(
            "Meeting captured via VisualSprint companion Chrome extension "
            "(Mode C). The signed-in user's own browser tab was captured; "
            "no bot participant joined the meeting."
        ),
    )
    session.state = CaptureState.ACQUIRING
    enqueue_pipeline(db, org_id, session.id)
    db.commit()

    log.info("companion.finalize.done", session_id=capture_session_id,
             chunks_used=len(chunks), missing=len(missing),
             keyframes=len(preextracted), roster=len(roster))
    return CompanionFinalizeResponse(capture_session_id=capture_session_id, enqueued=True)


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
