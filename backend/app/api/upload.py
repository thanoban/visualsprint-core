"""Mode D (manual upload) — the walking skeleton and cheapest onboarding path.

Upload a recording → meeting + capture_session(mode=D) + consent record →
audio stored in blob store → pipeline enqueued. Proves the entire spine
before any platform API exists.
"""

from typing import AsyncIterator

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.adapters.blobstore_s3 import get_blobstore
from app.auth import dependency as auth_dep
from app.auth.dependency import get_current_user, require_session_member
from app.capture.consent import record_disclosure
from app.db.base import get_db
from app.db.models import AudioTrack, CaptureSession, Meeting, User
from app.orchestrator.queue import enqueue_pipeline

router = APIRouter(prefix="/api/v1/meetings", tags=["meetings"])

ALLOWED_SUFFIXES = {".flac", ".wav", ".mp3", ".m4a", ".mp4", ".webm", ".ogg"}
VIDEO_SUFFIXES = {".mp4", ".webm"}  # doubles as the screen-capture source (docs/03-capture.md)
MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024  # 2 GiB
CHUNK_SIZE = 1024 * 1024  # 1 MiB — keeps memory per upload bounded


async def _checked_stream(file: UploadFile) -> AsyncIterator[bytes]:
    """Yield file chunks, raising 413 if the total exceeds MAX_UPLOAD_BYTES."""
    total = 0
    while True:
        chunk = await file.read(CHUNK_SIZE)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "file too large")
        yield chunk


class UploadResponse(BaseModel):
    meeting_id: str
    capture_session_id: str
    audio_uri: str
    state: str


@router.post("/upload", response_model=UploadResponse)
async def upload_meeting(
    file: UploadFile = File(...),
    title: str = Form(default=""),
    org_id: str = Form(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> UploadResponse:
    # org_id is a Form field, not a path param, so this can't use
    # Depends(require_org_member) -- same reasoning as chat.py/actions.py.
    # Every caller now has an org from GET /api/v1/me (their personal org
    # at minimum), so the old "auto-create a default org when none
    # supplied" convenience no longer applies -- org_id is required.
    if not auth_dep.is_org_member(db, org_id, user):
        raise HTTPException(403, "not a member of this org")

    suffix = (
        ("." + file.filename.rsplit(".", 1)[-1].lower())
        if file.filename and "." in file.filename
        else ""
    )
    if suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(
            415, f"unsupported file type '{suffix}'; allowed: {sorted(ALLOWED_SUFFIXES)}"
        )

    # Peek at first chunk to reject empty files before creating DB rows.
    first_chunk = await file.read(CHUNK_SIZE)
    if not first_chunk:
        raise HTTPException(400, "empty file")

    meeting = Meeting(
        org_id=org_id, title=title or (file.filename or "Uploaded meeting"), platform="upload"
    )
    db.add(meeting)
    db.flush()

    session = CaptureSession(org_id=org_id, meeting_id=meeting.id, mode="D")
    db.add(session)
    db.flush()

    blob = get_blobstore()

    async def _reassembled() -> AsyncIterator[bytes]:
        yield first_chunk
        async for chunk in _checked_stream(file):
            yield chunk

    audio_uri = await blob.put_stream(
        f"audio/{org_id}/{session.id}{suffix}",
        _reassembled(),
        file.content_type or "application/octet-stream",
    )

    # Mode D is "acquired" the moment the file lands — one mixed track, no
    # participant (uploader identity isn't a roster). Other modes populate
    # this from PlatformAdapter.acquire() instead of here.
    db.add(AudioTrack(org_id=org_id, capture_session_id=session.id, uri=audio_uri))

    # A video-format upload doubles as the screen-share source for the
    # `screen` stage — no separate demux/upload step for Mode D. Audio-only
    # uploads (.wav/.flac/.mp3/.m4a/.ogg) leave video_uri unset, and the
    # screen stage treats that as a normal, non-failing outcome.
    if suffix in VIDEO_SUFFIXES:
        session.video_uri = audio_uri

    # Mode D consent: the uploader attests they may share this recording.
    record_disclosure(
        db,
        session,
        subject="uploader",
        method="upload_attestation",
        detail=f"file={file.filename}",
    )

    enqueue_pipeline(db, org_id, session.id)
    db.commit()

    return UploadResponse(
        meeting_id=meeting.id,
        capture_session_id=session.id,
        audio_uri=audio_uri,
        state=session.state.value,
    )


@router.get("/sessions/{capture_session_id}")
async def get_session(
    capture_session_id: str,
    session: CaptureSession = Depends(require_session_member),
) -> dict:
    # session resolved and org-authorized by require_session_member
    return {
        "id": session.id,
        "meeting_id": session.meeting_id,
        "mode": session.mode,
        "state": session.state.value,
        "error": session.error,
    }
