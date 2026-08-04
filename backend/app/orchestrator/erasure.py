"""On-demand right-to-erasure — the PDPA data-subject request path, distinct
from retention.py's automatic raw-evidence-only sweep.

retention.py deliberately keeps KnowledgeItem/Evidence/Edge rows on the
theory that a purge is time-based and automatic, so verified organizational
memory outlives the raw recording it was derived from. A data-subject
erasure request is different: someone is asking for a specific meeting's
data to be gone now, in full, not just the raw evidence. This module does
the complete cascade delete, in FK-dependency order (children before
parents), including every blob a session references.

GlossaryTerm is org-level and outlives any single meeting: a term whose
source_correction_id points at a correction being deleted keeps the term,
just clears the now-dangling reference — same "structurally lower privacy
risk, higher product value" reasoning retention.py applies to knowledge.
"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import (
    AudioTrack,
    CaptureSession,
    ConsentRecord,
    Correction,
    CoverageInterval,
    GlossaryTerm,
    Keyframe,
    KnowledgeEdge,
    KnowledgeEvidence,
    KnowledgeItem,
    Meeting,
    Participant,
    PipelineJob,
    ProposedAction,
    Utterance,
    UtteranceKeyframe,
)
from app.interfaces.blobstore import BlobStore


async def erase_meeting(db: Session, meeting: Meeting, blob_store: BlobStore) -> None:
    """Deletes a meeting and everything derived from it. Does not commit —
    caller owns the transaction, same convention as retention.py and
    scheduler.py."""
    sessions = (
        db.execute(select(CaptureSession).where(CaptureSession.meeting_id == meeting.id))
        .scalars()
        .all()
    )
    for session in sessions:
        await _erase_capture_session(db, session, blob_store)

    db.delete(meeting)


async def _erase_capture_session(db: Session, session: CaptureSession, blob_store: BlobStore) -> None:
    knowledge_item_ids = [
        row
        for row in db.execute(
            select(KnowledgeItem.id).where(KnowledgeItem.capture_session_id == session.id)
        ).scalars()
    ]
    if knowledge_item_ids:
        db.query(KnowledgeEdge).filter(
            KnowledgeEdge.from_item_id.in_(knowledge_item_ids)
            | KnowledgeEdge.to_item_id.in_(knowledge_item_ids)
        ).delete(synchronize_session=False)
        db.query(KnowledgeEvidence).filter(
            KnowledgeEvidence.knowledge_item_id.in_(knowledge_item_ids)
        ).delete(synchronize_session=False)
        db.query(KnowledgeItem).filter(KnowledgeItem.capture_session_id == session.id).delete(
            synchronize_session=False
        )

    db.query(UtteranceKeyframe).filter(
        UtteranceKeyframe.utterance_id.in_(
            select(Utterance.id).where(Utterance.capture_session_id == session.id)
        )
    ).delete(synchronize_session=False)

    correction_ids = [
        row
        for row in db.execute(
            select(Correction.id).where(
                Correction.utterance_id.in_(
                    select(Utterance.id).where(Utterance.capture_session_id == session.id)
                )
            )
        ).scalars()
    ]
    if correction_ids:
        db.query(GlossaryTerm).filter(GlossaryTerm.source_correction_id.in_(correction_ids)).update(
            {GlossaryTerm.source_correction_id: None}, synchronize_session="fetch"
        )
        db.query(Correction).filter(Correction.id.in_(correction_ids)).delete(
            synchronize_session=False
        )

    db.query(Utterance).filter(Utterance.capture_session_id == session.id).delete(
        synchronize_session=False
    )

    keyframes = (
        db.execute(select(Keyframe).where(Keyframe.capture_session_id == session.id)).scalars().all()
    )
    for kf in keyframes:
        if kf.image_uri:
            await blob_store.delete(kf.image_uri)
    db.query(Keyframe).filter(Keyframe.capture_session_id == session.id).delete(
        synchronize_session=False
    )

    audio_tracks = (
        db.execute(select(AudioTrack).where(AudioTrack.capture_session_id == session.id))
        .scalars()
        .all()
    )
    for track in audio_tracks:
        if track.uri:
            await blob_store.delete(track.uri)
    db.query(AudioTrack).filter(AudioTrack.capture_session_id == session.id).delete(
        synchronize_session=False
    )

    if session.video_uri:
        await blob_store.delete(session.video_uri)

    db.query(ProposedAction).filter(ProposedAction.capture_session_id == session.id).delete(
        synchronize_session=False
    )
    db.query(ConsentRecord).filter(ConsentRecord.capture_session_id == session.id).delete(
        synchronize_session=False
    )
    db.query(CoverageInterval).filter(CoverageInterval.capture_session_id == session.id).delete(
        synchronize_session=False
    )
    db.query(Participant).filter(Participant.capture_session_id == session.id).delete(
        synchronize_session=False
    )
    db.query(PipelineJob).filter(PipelineJob.capture_session_id == session.id).delete(
        synchronize_session=False
    )

    db.delete(session)
