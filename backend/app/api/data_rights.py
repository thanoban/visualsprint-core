"""Data-subject rights — PDPA export & on-demand erasure, per meeting.

Distinct from app/orchestrator/retention.py's automatic time-based sweep
(which only scrubs raw evidence and keeps knowledge intact): these endpoints
are triggered by an explicit request and do a complete, irreversible delete
of everything derived from one meeting (app/orchestrator/erasure.py). Export
exists so a deletion request can be preceded by "give me a copy first" — the
same portability right the erasure endpoint enforces the erasure half of.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.adapters.blobstore_s3 import get_blobstore
from app.auth.dependency import require_org_member
from app.db.base import get_db
from app.db.models import (
    AudioTrack,
    CaptureSession,
    ConsentRecord,
    CoverageInterval,
    Keyframe,
    KnowledgeItem,
    Meeting,
    Org,
    Participant,
    ProposedAction,
    Utterance,
)
from app.orchestrator.audit import log_audit_event
from app.orchestrator.erasure import erase_meeting

router = APIRouter(prefix="/api/v1", tags=["data-rights"])


class OrgSettingsOut(BaseModel):
    org_id: str
    retention_days: int | None
    join_policy: str


@router.get("/orgs/{org_id}/settings", response_model=OrgSettingsOut)
async def get_org_settings(
    org_id: str, db: Session = Depends(get_db), _: None = Depends(require_org_member)
) -> OrgSettingsOut:
    org = db.get(Org, org_id)
    if org is None:
        raise HTTPException(404, "org not found")
    return OrgSettingsOut(org_id=org.id, retention_days=org.retention_days, join_policy=org.join_policy)


class UpdateOrgSettingsRequest(BaseModel):
    # None is a real, meaningful value here (Org.retention_days: None = keep
    # forever, the platform default) -- so this can't reuse "field absent"
    # to mean "no-op". `retention_days_set` disambiguates: only touch the
    # column when the caller actually included the field, whatever its value.
    retention_days: int | None = None
    retention_days_set: bool = False


@router.patch("/orgs/{org_id}/settings", response_model=OrgSettingsOut)
async def update_org_settings(
    org_id: str,
    req: UpdateOrgSettingsRequest,
    db: Session = Depends(get_db),
    _: None = Depends(require_org_member),
) -> OrgSettingsOut:
    org = db.get(Org, org_id)
    if org is None:
        raise HTTPException(404, "org not found")
    if req.retention_days_set:
        if req.retention_days is not None and req.retention_days <= 0:
            raise HTTPException(400, "retention_days must be a positive integer, or null to keep forever")
        org.retention_days = req.retention_days
        log_audit_event(
            db,
            org_id=org.id,
            actor="system",
            event="org_retention_updated",
            detail={"retention_days": req.retention_days},
        )
    db.commit()
    return OrgSettingsOut(org_id=org.id, retention_days=org.retention_days, join_policy=org.join_policy)


def _get_org_meeting(db: Session, org_id: str, meeting_id: str) -> Meeting:
    if db.get(Org, org_id) is None:
        raise HTTPException(404, "org not found")
    meeting = db.get(Meeting, meeting_id)
    if meeting is None or meeting.org_id != org_id:
        raise HTTPException(404, "meeting not found")
    return meeting


@router.get("/orgs/{org_id}/meetings/{meeting_id}/export")
async def export_meeting(
    org_id: str,
    meeting_id: str,
    db: Session = Depends(get_db),
    _: None = Depends(require_org_member),
) -> dict:
    """Full data-portability dump: every row this org's data derived from
    this meeting, across every capture session it had. Blob content itself
    (audio/keyframe images) is referenced by URI, not inlined -- the
    recipient of an export request gets pointers to the actual files via
    the blobstore, not a multi-gigabyte JSON body."""
    meeting = _get_org_meeting(db, org_id, meeting_id)
    sessions = (
        db.execute(select(CaptureSession).where(CaptureSession.meeting_id == meeting.id))
        .scalars()
        .all()
    )

    session_dumps = []
    for session in sessions:
        session_dumps.append(
            {
                "capture_session_id": session.id,
                "mode": session.mode,
                "state": session.state.value,
                "video_uri": session.video_uri,
                "disclosure_log": session.disclosure_log,
                "consent_records": [
                    {"subject": c.subject, "method": c.method, "detail": c.detail, "at": c.created_at.isoformat()}
                    for c in db.execute(
                        select(ConsentRecord).where(ConsentRecord.capture_session_id == session.id)
                    ).scalars()
                ],
                "participants": [
                    {"display_name": p.display_name, "platform_user_id": p.platform_user_id}
                    for p in db.execute(
                        select(Participant).where(Participant.capture_session_id == session.id)
                    ).scalars()
                ],
                "audio_tracks": [
                    {"uri": t.uri, "participant_display_name": t.participant_display_name}
                    for t in db.execute(
                        select(AudioTrack).where(AudioTrack.capture_session_id == session.id)
                    ).scalars()
                ],
                "utterances": [
                    {
                        "start_s": u.start_s,
                        "end_s": u.end_s,
                        "text": u.text,
                        "lang_tags": u.lang_tags,
                        "provider": u.provider,
                    }
                    for u in db.execute(
                        select(Utterance)
                        .where(Utterance.capture_session_id == session.id)
                        .order_by(Utterance.start_s)
                    ).scalars()
                ],
                "keyframes": [
                    {
                        "valid_from_s": k.valid_from_s,
                        "valid_to_s": k.valid_to_s,
                        "image_uri": k.image_uri,
                        "ocr_text": k.ocr_text,
                        "vlm_caption": k.vlm_caption,
                    }
                    for k in db.execute(
                        select(Keyframe).where(Keyframe.capture_session_id == session.id)
                    ).scalars()
                ],
                "knowledge_items": [
                    {
                        "type": ki.type.value,
                        "statement": ki.statement,
                        "lifecycle_state": ki.lifecycle_state.value,
                        "confidence": ki.confidence.value,
                    }
                    for ki in db.execute(
                        select(KnowledgeItem).where(KnowledgeItem.capture_session_id == session.id)
                    ).scalars()
                ],
                "coverage_intervals": [
                    {
                        "start_s": ci.start_s,
                        "end_s": ci.end_s,
                        "modality": ci.modality,
                        "status": ci.status.value,
                        "reason": ci.reason,
                    }
                    for ci in db.execute(
                        select(CoverageInterval).where(CoverageInterval.capture_session_id == session.id)
                    ).scalars()
                ],
                "proposed_actions": [
                    {"kind": a.kind, "status": a.status.value, "payload": a.payload}
                    for a in db.execute(
                        select(ProposedAction).where(ProposedAction.capture_session_id == session.id)
                    ).scalars()
                ],
            }
        )

    return {
        "meeting_id": meeting.id,
        "title": meeting.title,
        "platform": meeting.platform,
        "scheduled_start": meeting.scheduled_start.isoformat() if meeting.scheduled_start else None,
        "scheduled_end": meeting.scheduled_end.isoformat() if meeting.scheduled_end else None,
        "capture_sessions": session_dumps,
    }


class EraseMeetingResponse(BaseModel):
    meeting_id: str
    erased: bool


@router.delete("/orgs/{org_id}/meetings/{meeting_id}", response_model=EraseMeetingResponse)
async def delete_meeting(
    org_id: str,
    meeting_id: str,
    requested_by: str = "",
    db: Session = Depends(get_db),
    _: None = Depends(require_org_member),
) -> EraseMeetingResponse:
    """Irreversible. Deletes the meeting and everything derived from every
    capture session it had -- transcripts, keyframes, knowledge, actions,
    consent records, and the underlying audio/video/image blobs. There is
    no undo; a caller that wants a copy first should hit the export
    endpoint before this one."""
    meeting = _get_org_meeting(db, org_id, meeting_id)

    # meeting_id only, deliberately -- erase_meeting() below deletes the
    # Meeting row (title included), and the audit trail itself has no purge
    # path (AuditLog carries no FK to scrub via), so writing meeting.title
    # here would defeat the erasure it's supposed to be recording: the
    # "irreversible... no undo" delete would leave exactly the content it
    # deleted sitting in this row forever.
    log_audit_event(
        db,
        org_id=org_id,
        actor=requested_by or "system",
        event="meeting_erasure_requested",
        detail={"meeting_id": meeting_id},
    )
    await erase_meeting(db, meeting, get_blobstore())
    db.commit()

    return EraseMeetingResponse(meeting_id=meeting_id, erased=True)
