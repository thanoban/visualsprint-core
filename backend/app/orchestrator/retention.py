"""Raw-evidence retention sweep -- Org.retention_days opt-in only, never a
platform default (interfaces/blobstore.py: audio/keyframes are kept forever
by default -- the corpus is the moat -- this is the per-org exception for
orgs with their own compliance requirements to purge sooner).

Purges the actual recording content -- audio/video blobs, transcript text,
keyframe images/OCR/caption -- while leaving verified organizational
memory (KnowledgeItem's statement/type/confidence/owner/due_at/
lifecycle_state/embedding, KnowledgeEvidence, KnowledgeEdge) untouched:
that's the product's whole value and is structurally lower privacy risk
than raw recordings, so this sweep never purges it. The one exception is
KnowledgeItem.confidence_rationale -- Evidence Verification's own free-text
explanation of *why* it assigned a confidence level, which can quote or
closely paraphrase the raw evidence it was judging (see
app/agents/verification.py's SYSTEM_PROMPT). Leaving it behind would let a
purged meeting's transcript substance keep leaking through the report's
rationale display, so it's cleared alongside the raw evidence, not treated
as memory.
Evidence rows keep their id/timing/speaker after a purge, so a report for
an old meeting still renders correctly -- app/api/report.py's existing
`quote = _truncate(utt.text) if utt.text else None` already treats blank
text as "no quote to show", so purged evidence degrades to "the evidence
existed, its content is no longer available" rather than a broken
reference or a crash.

Idempotent by construction: an already-purged row has blank text/uri
already, so re-running this sweep on the same session is a safe no-op --
no separate "purged_at" bookkeeping column needed.
"""

from datetime import UTC, datetime, timedelta

import structlog
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import (
    AudioTrack,
    CaptureSession,
    Keyframe,
    KnowledgeItem,
    Meeting,
    Org,
    Utterance,
)
from app.interfaces.blobstore import BlobStore

log = structlog.get_logger()


async def purge_expired_raw_evidence(
    db: Session, org: Org, blob_store: BlobStore, *, now: datetime | None = None
) -> list[str]:
    """One pass for one org. No-ops immediately if the org has no retention
    policy (Org.retention_days is None means "keep forever", the platform
    default). Does not commit -- caller owns the transaction, same
    convention as app/orchestrator/scheduler.py's sync_calendar_connection.
    Returns the capture_session ids that had anything purged this pass."""
    if org.retention_days is None:
        return []
    now = now or datetime.now(UTC)
    cutoff = now - timedelta(days=org.retention_days)

    rows = db.execute(
        select(CaptureSession, Meeting)
        .join(Meeting, CaptureSession.meeting_id == Meeting.id)
        .where(CaptureSession.org_id == org.id)
    ).all()

    purged_session_ids: list[str] = []
    for session, meeting in rows:
        # Effective meeting time: scheduled_start when known (platform-
        # captured meetings); Mode D uploads have no calendar event to
        # anchor to, so fall back to when the capture session was created.
        effective_time = meeting.scheduled_start or session.created_at
        if effective_time is None:
            continue
        # SQLite (unlike Postgres' DateTime(timezone=True), what production
        # actually runs on) silently drops tzinfo on read-back -- normalize
        # defensively so this comparison is correct on either backend rather
        # than relying on every driver preserving awareness consistently.
        if effective_time.tzinfo is None:
            effective_time = effective_time.replace(tzinfo=UTC)
        if effective_time > cutoff:
            continue

        if await _purge_session_raw_evidence(db, session.id, blob_store):
            purged_session_ids.append(session.id)

    return purged_session_ids


async def _purge_session_raw_evidence(
    db: Session, capture_session_id: str, blob_store: BlobStore
) -> bool:
    purged_anything = False

    audio_tracks = (
        db.execute(select(AudioTrack).where(AudioTrack.capture_session_id == capture_session_id))
        .scalars()
        .all()
    )
    for track in audio_tracks:
        if not track.uri:
            continue
        await blob_store.delete(track.uri)
        track.uri = ""
        purged_anything = True

    utterances = (
        db.execute(select(Utterance).where(Utterance.capture_session_id == capture_session_id))
        .scalars()
        .all()
    )
    for utt in utterances:
        if not utt.text:
            continue
        utt.text = ""
        purged_anything = True

    keyframes = (
        db.execute(select(Keyframe).where(Keyframe.capture_session_id == capture_session_id))
        .scalars()
        .all()
    )
    for kf in keyframes:
        if not (kf.image_uri or kf.ocr_text or kf.vlm_caption):
            continue
        if kf.image_uri:
            await blob_store.delete(kf.image_uri)
        kf.image_uri = ""
        kf.ocr_text = ""
        kf.vlm_caption = ""
        kf.detected_entities = []
        purged_anything = True

    items = (
        db.execute(
            select(KnowledgeItem).where(KnowledgeItem.capture_session_id == capture_session_id)
        )
        .scalars()
        .all()
    )
    for item in items:
        if not item.confidence_rationale:
            continue
        item.confidence_rationale = ""
        purged_anything = True

    if purged_anything:
        log.info("retention.session_purged", capture_session_id=capture_session_id)
    return purged_anything
