"""Automatic post-pipeline raw-recording deletion.

Called immediately after the stage that finishes extracting derived artifacts
from the raw recording data. This is NOT opt-in — it runs for every session
regardless of Org.retention_days (which is the second tier: controls when
derived artifacts like transcripts and keyframe images are also purged).

Two-tier model
--------------
Tier 1 (here): raw audio / video blobs deleted automatically after the
    pipeline stage that consumed them. No user configuration needed.
    - AudioTrack.uri (WAV/FLAC) deleted after `transcribe` succeeds.
    - CaptureSession.video_uri deleted after `screen` succeeds.

Tier 2 (retention.py): Utterance.text, Keyframe.image_uri, and
    KnowledgeItem.confidence_rationale purged only for orgs that set
    Org.retention_days. Derived artifacts are retained by default.

What is kept permanently (never deleted here)
---------------------------------------------
- Utterance.text (the transcript — the product's value)
- Keyframe.image_uri / .ocr_text / .vlm_caption (report evidence)
- KnowledgeItem.* (all derived memory)
- CoverageInterval rows (honest gap disclosure)

Companion WebM chunks (companion-chunks/{org_id}/{session_id}/*.webm)
are already assembled into a WAV before the pipeline runs. The WAV is
tracked as AudioTrack.uri and is deleted here. The raw chunks themselves
are cleaned up by a GCS lifecycle rule on the companion-chunks/ prefix
(set Object Lifecycle: delete after Age=1 day — zero code, near-zero cost).
"""

import structlog
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import AudioTrack, CaptureSession
from app.interfaces.blobstore import BlobStore

log = structlog.get_logger()


async def delete_raw_audio(
    db: Session, capture_session_id: str, blob_store: BlobStore
) -> int:
    """Delete audio blobs for this session and clear AudioTrack.uri.

    Skips any AudioTrack whose URI is also CaptureSession.video_uri: a
    Mode D video upload reuses the same blob for both audio (transcription
    source) and video (screen stage source). Deleting it after transcribe
    would deprive the screen stage of its input. Those tracks are cleared
    by delete_raw_video after the screen stage finishes instead.

    Idempotent: tracks with an already-empty uri are skipped.
    Blob-store errors are logged and swallowed so a GCS hiccup never
    rolls back an otherwise-successful transcription.
    Returns the number of blobs deleted.
    """
    session = db.get(CaptureSession, capture_session_id)
    video_uri = session.video_uri if session else None

    tracks = (
        db.execute(select(AudioTrack).where(AudioTrack.capture_session_id == capture_session_id))
        .scalars()
        .all()
    )
    deleted = 0
    for track in tracks:
        if not track.uri:
            continue
        if video_uri and track.uri == video_uri:
            # Same blob serves both audio and video; let delete_raw_video
            # handle it after the screen stage extracts keyframes.
            continue
        try:
            await blob_store.delete(track.uri)
        except Exception as exc:
            log.warning(
                "raw_cleanup.audio_delete_failed",
                session=capture_session_id,
                track=track.id,
                uri=track.uri,
                error=str(exc),
            )
        track.uri = ""
        deleted += 1
    if deleted:
        log.info("raw_cleanup.audio_deleted", session=capture_session_id, tracks=deleted)
    return deleted


async def delete_raw_video(
    db: Session, capture_session_id: str, video_uri: str, blob_store: BlobStore
) -> bool:
    """Delete the video blob and clear CaptureSession.video_uri.

    Also clears AudioTrack.uri on any tracks that pointed to the same blob
    (Mode D video upload reuses one blob for both; delete_raw_audio skips
    those URIs so they don't disappear before the screen stage runs).

    Idempotent: no-ops when video_uri is already empty.
    Blob-store errors are logged and swallowed — same policy as audio.
    Returns True when a blob was actually deleted.
    """
    session = db.get(CaptureSession, capture_session_id)
    if session is None or not session.video_uri:
        return False
    try:
        await blob_store.delete(video_uri)
    except Exception as exc:
        log.warning(
            "raw_cleanup.video_delete_failed",
            session=capture_session_id,
            uri=video_uri,
            error=str(exc),
        )
    session.video_uri = ""

    # Clear the matching AudioTrack.uri (same blob, deferred from delete_raw_audio).
    tracks = (
        db.execute(select(AudioTrack).where(AudioTrack.capture_session_id == capture_session_id))
        .scalars()
        .all()
    )
    for track in tracks:
        if track.uri == video_uri:
            track.uri = ""

    log.info("raw_cleanup.video_deleted", session=capture_session_id)
    return True
