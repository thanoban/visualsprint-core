"""Shared read policy for project meetings, including legacy API entry points.

Callers authenticate workspace membership separately. SQL filtering happens
before retrieval/limits so inaccessible meetings cannot displace visible ones.
Historical ownerless meetings retain legacy access only outside the v2 pilot.
"""

from sqlalchemy import Select, and_, exists, or_, select
from sqlalchemy.orm import Session

from app.db.models import Meeting, MeetingAssignment, Org, ProjectMember


def visible_meeting_ids(org_id: str, user_id: str) -> Select[tuple[str]]:
    assigned = exists().where(
        MeetingAssignment.org_id == org_id,
        MeetingAssignment.meeting_id == Meeting.id,
    )
    project_access = exists().where(
        MeetingAssignment.org_id == org_id,
        MeetingAssignment.meeting_id == Meeting.id,
        ProjectMember.org_id == org_id,
        ProjectMember.project_id == MeetingAssignment.project_id,
        ProjectMember.user_id == user_id,
    )
    legacy_access = and_(Meeting.owner_user_id.is_(None), Org.pilot_features_enabled.is_(False))
    return (
        select(Meeting.id)
        .join(Org, Org.id == Meeting.org_id)
        .where(
            Meeting.org_id == org_id,
            or_(
                project_access,
                and_(~assigned, or_(Meeting.owner_user_id == user_id, legacy_access)),
            ),
        )
    )


def can_read_meeting(db: Session, org_id: str, meeting_id: str, user_id: str) -> bool:
    return (
        db.scalar(visible_meeting_ids(org_id, user_id).where(Meeting.id == meeting_id)) is not None
    )


def can_edit_meeting(db: Session, org_id: str, meeting_id: str, user_id: str) -> bool:
    if not can_read_meeting(db, org_id, meeting_id, user_id):
        return False
    assignment = db.scalar(
        select(MeetingAssignment).where(
            MeetingAssignment.org_id == org_id, MeetingAssignment.meeting_id == meeting_id
        )
    )
    if assignment is None:
        return True
    role = db.scalar(
        select(ProjectMember.role).where(
            ProjectMember.org_id == org_id,
            ProjectMember.project_id == assignment.project_id,
            ProjectMember.user_id == user_id,
        )
    )
    return role in {"owner", "editor"}
