"""Mode D (manual upload) — the walking skeleton and cheapest onboarding path.

Upload a recording → meeting + capture_session(mode=D) + consent record →
audio stored in blob store → pipeline enqueued. Proves the entire spine
before any platform API exists.
"""

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.adapters.blobstore_s3 import get_blobstore
from app.db.base import get_db
from app.db.models import AudioTrack, CaptureSession, ConsentRecord, Meeting, Org
from app.orchestrator.queue import enqueue_pipeline

router = APIRouter(prefix="/api/v1/meetings", tags=["meetings"])

ALLOWED_SUFFIXES = {".flac", ".wav", ".mp3", ".m4a", ".mp4", ".webm", ".ogg"}
MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024  # 2 GiB


class UploadResponse(BaseModel):
    meeting_id: str
    capture_session_id: str
    audio_uri: str
    state: str


@router.post("/upload", response_model=UploadResponse)
async def upload_meeting(
    file: UploadFile = File(...),
    title: str = Form(default=""),
    org_id: str = Form(default=""),
    db: Session = Depends(get_db),
) -> UploadResponse:
    suffix = ("." + file.filename.rsplit(".", 1)[-1].lower()) if file.filename and "." in file.filename else ""
    if suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(415, f"unsupported file type '{suffix}'; allowed: {sorted(ALLOWED_SUFFIXES)}")

    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "file too large")
    if not data:
        raise HTTPException(400, "empty file")

    # Dev convenience: auto-create a default org when none supplied.
    if not org_id:
        org = db.query(Org).filter(Org.name == "default").one_or_none()
        if org is None:
            org = Org(name="default")
            db.add(org)
            db.flush()
        org_id = org.id
    elif db.get(Org, org_id) is None:
        raise HTTPException(404, "org not found")

    meeting = Meeting(org_id=org_id, title=title or (file.filename or "Uploaded meeting"), platform="upload")
    db.add(meeting)
    db.flush()

    session = CaptureSession(org_id=org_id, meeting_id=meeting.id, mode="D")
    db.add(session)
    db.flush()

    blob = get_blobstore()
    audio_uri = await blob.put(
        f"audio/{org_id}/{session.id}{suffix}", data, file.content_type or "application/octet-stream"
    )

    # Mode D is "acquired" the moment the file lands — one mixed track, no
    # participant (uploader identity isn't a roster). Other modes populate
    # this from PlatformAdapter.acquire() instead of here.
    db.add(AudioTrack(org_id=org_id, capture_session_id=session.id, uri=audio_uri))

    # Mode D consent: the uploader attests they may share this recording.
    db.add(
        ConsentRecord(
            org_id=org_id,
            capture_session_id=session.id,
            subject="uploader",
            method="upload_attestation",
            detail=f"file={file.filename}",
        )
    )

    enqueue_pipeline(db, org_id, session.id)
    db.commit()

    return UploadResponse(
        meeting_id=meeting.id,
        capture_session_id=session.id,
        audio_uri=audio_uri,
        state=session.state.value,
    )


@router.get("/sessions/{session_id}")
async def get_session(session_id: str, db: Session = Depends(get_db)) -> dict:
    session = db.get(CaptureSession, session_id)
    if session is None:
        raise HTTPException(404, "session not found")
    return {
        "id": session.id,
        "meeting_id": session.meeting_id,
        "mode": session.mode,
        "state": session.state.value,
        "error": session.error,
    }
