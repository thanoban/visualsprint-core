"""Owned meeting and capture intent creation, with one atomic project assignment."""

import hashlib
import json
import uuid
from contextlib import suppress
from datetime import UTC, datetime

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.capture.requests import (
    CaptureRequestConflict,
    CaptureRequestResult,
    CaptureRequestScopeError,
    create_capture_request,
)
from app.db.models import (
    CaptureRequest,
    CaptureRequestStatus,
    Meeting,
    MeetingAssignment,
    Org,
    OrgMember,
    OutboxEvent,
    Project,
    ProjectMember,
    ProjectStatus,
)
from app.interfaces.capture_provider import MeetingTarget
from app.interfaces.secretstore import SecretStore
from app.modules.projects.access import can_read_meeting, visible_meeting_ids


async def capture_meeting(
    db: Session,
    secrets: SecretStore,
    *,
    org_id: str,
    actor_id: str,
    key: str,
    meeting_url: str,
    title: str,
    project_id: str | None,
    estimated_seconds: int,
) -> CaptureRequestResult:
    # Every HTTP attempt owns its provisional secret. A rejected or duplicate
    # request must never remove another concurrently committed request's URL.
    ref = f"capture-url/{org_id}/{uuid.uuid4()}"
    try:
        return await _capture_meeting(
            db,
            secrets,
            org_id=org_id,
            actor_id=actor_id,
            key=key,
            meeting_url=meeting_url,
            title=title,
            project_id=project_id,
            estimated_seconds=estimated_seconds,
            ref=ref,
        )
    finally:
        db.rollback()
        referenced = db.scalar(
            select(CaptureRequest.id).where(CaptureRequest.meeting_url_secret_ref == ref).limit(1)
        )
        db.commit()
        if referenced is None:
            # Preserve the original validation/provider error if cleanup also
            # fails. SecretStore inventory reconciliation remains an ops gate.
            with suppress(Exception):
                await secrets.delete(ref)


async def _capture_meeting(
    db: Session,
    secrets: SecretStore,
    *,
    org_id: str,
    actor_id: str,
    key: str,
    meeting_url: str,
    title: str,
    project_id: str | None,
    estimated_seconds: int,
    ref: str,
) -> CaptureRequestResult:
    target = MeetingTarget.from_url(meeting_url)
    document = {
        "actor": actor_id,
        "url": target.meeting_url,
        "title": title.strip(),
        "project": project_id,
        "seconds": estimated_seconds,
    }
    digest = hashlib.sha256(json.dumps(document, sort_keys=True).encode()).hexdigest()
    member = db.scalar(
        select(OrgMember.id).where(OrgMember.org_id == org_id, OrgMember.user_id == actor_id)
    )
    if member is None:
        raise CaptureRequestScopeError("workspace not found")
    db.commit()
    await secrets.put(ref, target.meeting_url)
    org = db.scalar(select(Org).where(Org.id == org_id).with_for_update())
    if (
        org is None
        or org.deleted_at is not None
        or db.scalar(
            select(OrgMember.id).where(OrgMember.org_id == org_id, OrgMember.user_id == actor_id)
        )
        is None
    ):
        raise CaptureRequestScopeError("workspace not found")
    existing = db.scalar(
        select(CaptureRequest).where(
            CaptureRequest.org_id == org_id, CaptureRequest.idempotency_key == key
        )
    )
    if existing:
        if (
            existing.requested_by != actor_id
            or existing.policy_snapshot.get("capture_input") != digest
        ):
            raise CaptureRequestConflict("idempotency key was used for different capture input")
        if not can_read_meeting(db, org_id, existing.meeting_id, actor_id):
            raise CaptureRequestScopeError("meeting not found")
        db.commit()
        return CaptureRequestResult(existing, False)
    # A new browser/tab key must not enqueue a second live capture for this
    # actor. Future calendar occurrences sharing a recurring link are distinct.
    due_dispatch = select(OutboxEvent.entity_id).where(
        OutboxEvent.org_id == org_id,
        OutboxEvent.operation == "capture.dispatch",
        OutboxEvent.run_at <= datetime.now(UTC),
    )
    active = db.scalar(
        select(CaptureRequest.id)
        .where(
            CaptureRequest.org_id == org_id,
            CaptureRequest.requested_by == actor_id,
            CaptureRequest.platform == target.platform,
            CaptureRequest.native_meeting_id == target.native_meeting_id,
            CaptureRequest.status.not_in(
                [
                    CaptureRequestStatus.FAILED,
                    CaptureRequestStatus.CANCELLED,
                    CaptureRequestStatus.FINALIZED,
                ]
            ),
            CaptureRequest.meeting_id.in_(visible_meeting_ids(org_id, actor_id)),
            or_(
                CaptureRequest.status != CaptureRequestStatus.QUEUED,
                CaptureRequest.id.in_(due_dispatch),
            ),
        )
        .limit(1)
    )
    if active:
        raise CaptureRequestConflict(
            "This meeting already has an active capture. Open it from Capture now; do not queue another."
        )
    if project_id:
        project = db.scalar(
            select(Project)
            .where(Project.org_id == org_id, Project.id == project_id)
            .with_for_update()
        )
        role = db.scalar(
            select(ProjectMember.role).where(
                ProjectMember.org_id == org_id,
                ProjectMember.project_id == project_id,
                ProjectMember.user_id == actor_id,
            )
        )
        if (
            project is None
            or project.deleted_at is not None
            or project.status != ProjectStatus.ACTIVE
            or role not in {"owner", "editor"}
        ):
            raise CaptureRequestScopeError("editable project not found")
    meeting = Meeting(
        org_id=org_id,
        owner_user_id=actor_id,
        title=title.strip() or "Instant meeting",
        platform=target.platform,
        platform_meeting_id=target.native_meeting_id,
        scheduled_start=datetime.now(UTC),
    )
    db.add(meeting)
    db.flush()
    if project_id:
        db.add(
            MeetingAssignment(
                org_id=org_id, meeting_id=meeting.id, project_id=project_id, assigned_by=actor_id
            )
        )
        db.flush()
    result = create_capture_request(
        db,
        org_id=org_id,
        meeting_id=meeting.id,
        requested_by=actor_id,
        idempotency_key=key,
        target=target,
        meeting_url_secret_ref=ref,
        policy_snapshot={"capture_input": digest, "language": "en"},
        estimated_seconds=estimated_seconds,
    )
    db.commit()
    return result
