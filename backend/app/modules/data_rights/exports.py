"""Bounded, authenticated transcript/knowledge exports; never bearer download URLs."""

import hashlib
import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.db.models import (
    AsyncJobStatus,
    CaptureSession,
    Confidence,
    ExportJob,
    KnowledgeItem,
    Meeting,
    MeetingAssignment,
    OrgMember,
    ProjectMember,
    Utterance,
)
from app.infrastructure.jobs.leases import claim_next, finish, owned_event
from app.modules.projects.access import visible_meeting_ids


class ExportUnavailable(Exception):
    pass


def utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def build_manifest(db: Session, job: ExportJob) -> tuple[dict[str, object], str]:
    role = db.scalar(
        select(OrgMember.role).where(
            OrgMember.org_id == job.org_id, OrgMember.user_id == job.created_by
        )
    )
    if role is None or (job.scope_kind == "workspace" and role != "owner"):
        raise ExportUnavailable("export_access_changed")
    if (
        job.scope_kind == "project"
        and db.scalar(
            select(ProjectMember.id).where(
                ProjectMember.org_id == job.org_id,
                ProjectMember.project_id == job.scope_id,
                ProjectMember.user_id == job.created_by,
            )
        )
        is None
    ):
        raise ExportUnavailable("export_access_changed")
    query = visible_meeting_ids(job.org_id, job.created_by)
    if job.scope_kind == "project":
        query = query.where(
            Meeting.id.in_(
                select(MeetingAssignment.meeting_id).where(
                    MeetingAssignment.org_id == job.org_id,
                    MeetingAssignment.project_id == job.scope_id,
                )
            )
        )
    meetings = list(
        db.scalars(select(Meeting).where(Meeting.id.in_(query)).order_by(Meeting.id).limit(101))
    )
    if len(meetings) > 100:
        raise ExportUnavailable("export_scope_too_large_use_project_scope")
    documents: list[dict[str, object]] = []
    size = 0
    for meeting in meetings:
        sessions = list(
            db.scalars(
                select(CaptureSession)
                .where(CaptureSession.org_id == job.org_id, CaptureSession.meeting_id == meeting.id)
                .order_by(CaptureSession.id)
            )
        )
        captures: list[dict[str, object]] = []
        for session in sessions:
            utterances = list(
                db.scalars(
                    select(Utterance)
                    .where(
                        Utterance.org_id == job.org_id, Utterance.capture_session_id == session.id
                    )
                    .order_by(Utterance.start_s, Utterance.id)
                    .limit(10001)
                )
            )
            items = list(
                db.scalars(
                    select(KnowledgeItem)
                    .where(
                        KnowledgeItem.org_id == job.org_id,
                        KnowledgeItem.capture_session_id == session.id,
                        KnowledgeItem.confidence.in_(
                            {Confidence.VERIFIED, Confidence.PARTIALLY_SUPPORTED}
                        ),
                    )
                    .order_by(KnowledgeItem.id)
                    .limit(2001)
                )
            )
            if len(utterances) > 10000 or len(items) > 2000:
                raise ExportUnavailable("export_meeting_too_large")
            captures.append(
                {
                    "id": session.id,
                    "processing_state": session.state.value,
                    "transcript": [
                        {
                            "id": u.id,
                            "start_s": float(u.start_s),
                            "end_s": float(u.end_s),
                            "text": u.text,
                            "speaker_label": u.speaker_cluster_id,
                        }
                        for u in utterances
                    ],
                    "verified_knowledge": [
                        {
                            "id": k.id,
                            "statement": k.statement,
                            "type": k.type.value,
                            "confidence": k.confidence.value,
                            "lifecycle": k.lifecycle_state.value,
                            "capture_gap": k.overlaps_coverage_gap,
                        }
                        for k in items
                    ],
                }
            )
        document: dict[str, object] = {
            "id": meeting.id,
            "title": meeting.title,
            "platform": meeting.platform,
            "captures": captures,
        }
        size += len(json.dumps(document).encode())
        if size > 10_000_000:
            raise ExportUnavailable("export_size_limit")
        documents.append(document)
    manifest: dict[str, object] = {
        "schema": "visualsprint.text-export.v1",
        "scope_kind": job.scope_kind,
        "scope_id": job.scope_id,
        "coverage": "Current actor's accessible meetings only; not hidden private projects",
        "meetings": documents,
    }
    digest = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()
    return manifest, digest


def export_next(sessions: Callable[[], Session], *, worker_id: str) -> bool:
    with sessions() as db:
        db.execute(
            update(ExportJob)
            .where(
                ExportJob.completed_at < datetime.now(UTC) - timedelta(hours=24),
                ExportJob.manifest.is_not(None),
            )
            .values(manifest=None, download_url=None)
        )
        db.commit()
    claim = claim_next(sessions, "data.export", worker_id)
    if claim is None:
        return False
    with sessions() as db:
        event = owned_event(db, claim)
        job = db.get(ExportJob, claim.entity_id)
        if event is None:
            return True
        if job is None or job.org_id != claim.org_id:
            finish(event, "export_job_missing")
        elif job.status == AsyncJobStatus.DONE:
            finish(event)
        else:
            try:
                manifest, digest = build_manifest(db, job)
                job.manifest = manifest
                job.source_hash = digest
                job.status, job.error = AsyncJobStatus.DONE, None
                job.completed_at = datetime.now(UTC)
                job.download_url = f"/api/v2/workspaces/{job.org_id}/exports/{job.id}/download"
                finish(event)
            except ExportUnavailable as exc:
                job.status, job.error = AsyncJobStatus.FAILED, str(exc)
                finish(event, str(exc))
        db.commit()
    return True
