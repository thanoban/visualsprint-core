"""Next-meeting agenda endpoints (F11).

POST /occurrences/{id}/agenda — generate (or retrieve) agenda for an occurrence.
GET  /occurrences/{id}/agenda — return the latest agenda version.
PATCH /agendas/{id}           — save user edits; optimistic version check.

Agenda sections are deterministically built from:
- The occurrence title (as the meeting topic)
- The latest project memory (decisions, open questions, commitments)

No LLM call is made in this slice.  The structured_summary from SummaryVersion
is used directly.  The LLM-enhanced generation path is gated behind a future
worker that writes directly to agenda_version rows.

Architecture rule: user edits are distinguishable (edited_by set); auto-refresh
produces a new row with a different input_revision_hash and does NOT overwrite
user edits.
"""

import hashlib
import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.dependency import get_current_user, require_org_member
from app.db.base import get_db
from app.db.models import (
    AgendaVersion,
    CalendarOccurrence,
    MeetingAssignment,
    Org,
    Project,
    ProjectMember,
    SummaryVersion,
    User,
)
from app.memory.project_memory import current_memory
from app.modules.projects.access import can_read_meeting

router = APIRouter(prefix="/api/v2/workspaces/{org_id}", tags=["agenda"])

_DEFAULT_SECTIONS = [
    {"heading": "Introductions", "notes": ""},
    {"heading": "Agenda review", "notes": ""},
    {"heading": "Open items", "notes": ""},
    {"heading": "Next steps", "notes": ""},
]


def _require_org(db: Session, org_id: str) -> None:
    if db.get(Org, org_id) is None:
        raise HTTPException(404, "workspace not found")


def _occurrence(db: Session, org_id: str, occurrence_id: str) -> CalendarOccurrence:
    occ = db.get(CalendarOccurrence, occurrence_id)
    if occ is None or occ.org_id != org_id:
        raise HTTPException(404, "occurrence not found")
    return occ


def _require_occurrence_access(
    db: Session, org_id: str, occ: CalendarOccurrence, user_id: str, *, edit: bool = False
) -> None:
    if occ.meeting_id is None:
        return  # Calendar ownership migration is a separate F03 gate.
    if not can_read_meeting(db, org_id, occ.meeting_id, user_id):
        raise HTTPException(404, "occurrence not found")
    project = _project_for_occurrence(db, org_id, occ.id)
    if edit and project is not None:
        role = db.scalar(
            select(ProjectMember.role).where(
                ProjectMember.org_id == org_id,
                ProjectMember.project_id == project.id,
                ProjectMember.user_id == user_id,
            )
        )
        if role not in {"owner", "editor"}:
            raise HTTPException(403, "project edit access required")


def _project_for_occurrence(db: Session, org_id: str, occurrence_id: str) -> Project | None:
    """Return the project assigned to the meeting linked from this occurrence, if any."""
    occ = db.get(CalendarOccurrence, occurrence_id)
    if occ is None or occ.meeting_id is None:
        return None
    assignment = db.execute(
        select(MeetingAssignment).where(
            MeetingAssignment.org_id == org_id,
            MeetingAssignment.meeting_id == occ.meeting_id,
        )
    ).scalar_one_or_none()
    if assignment is None:
        return None
    return db.get(Project, assignment.project_id)


def _build_sections(
    occurrence_title: str,
    memory: SummaryVersion | None,
    objective: str,
) -> list[dict[str, Any]]:
    sections: list[dict[str, Any]] = []

    if objective:
        sections.append({"heading": "Objective", "notes": objective})

    if memory and memory.structured_summary:
        ss = memory.structured_summary
        open_qs = ss.get("open_questions", [])
        if open_qs:
            notes = "\n".join(f"- {q.get('statement', '')}" for q in open_qs[:5])
            sections.append({"heading": "Open questions to address", "notes": notes})

        commitments = ss.get("commitments", [])
        if commitments:
            notes = "\n".join(f"- {c.get('statement', '')}" for c in commitments[:5])
            sections.append({"heading": "Commitment follow-ups", "notes": notes})

        decisions = ss.get("decisions", [])
        if decisions:
            notes = "\n".join(f"- {d.get('statement', '')}" for d in decisions[:3])
            sections.append({"heading": "Context: recent decisions", "notes": notes})

    if not sections:
        sections = [{"heading": occurrence_title or "Meeting", "notes": ""}]

    sections.append({"heading": "Next steps", "notes": ""})
    return sections


def _input_hash(occurrence: CalendarOccurrence, memory_id: str | None, objective: str) -> str:
    payload = json.dumps(
        {
            "occurrence_id": occurrence.id,
            "revision": occurrence.revision,
            "memory_id": memory_id,
            "objective": objective,
        },
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode()).hexdigest()


# --------------------------------------------------------------------------- #
# Request/response models
# --------------------------------------------------------------------------- #


class AgendaGenerateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    objective: str = Field(default="", max_length=1024)


class AgendaSectionIn(BaseModel):
    heading: str = Field(min_length=1, max_length=255)
    notes: str = Field(default="", max_length=4096)


class AgendaUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=1)
    sections: list[AgendaSectionIn]
    objective: str | None = Field(default=None, max_length=1024)


class AgendaView(BaseModel):
    id: str
    occurrence_id: str
    input_revision_hash: str
    sections: list[dict[str, Any]]
    objective: str
    edited_by: str | None = None
    version: int


# --------------------------------------------------------------------------- #
# Endpoints
# --------------------------------------------------------------------------- #


@router.post("/occurrences/{occurrence_id}/agenda", response_model=AgendaView, status_code=202)
def generate_agenda(
    org_id: str,
    occurrence_id: str,
    body: AgendaGenerateIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> AgendaView:
    """Generate or retrieve the agenda for an occurrence.

    Returns the existing agenda if the input hash hasn't changed.
    If the occurrence has an assigned meeting/project, injects context from
    the latest project memory.  Otherwise uses a generic template.
    """
    _require_org(db, org_id)
    occurrence = _occurrence(db, org_id, occurrence_id)
    _require_occurrence_access(db, org_id, occurrence, user.id, edit=True)

    project = _project_for_occurrence(db, org_id, occurrence_id)
    memory: SummaryVersion | None = None
    if project is not None:
        memory = current_memory(db, org_id, "project", project.id, user.id)

    rev_hash = _input_hash(occurrence, memory.id if memory else None, body.objective)

    existing = db.execute(
        select(AgendaVersion).where(
            AgendaVersion.occurrence_id == occurrence_id,
            AgendaVersion.input_revision_hash == rev_hash,
        )
    ).scalar_one_or_none()
    if existing is not None:
        return AgendaView(
            id=existing.id,
            occurrence_id=existing.occurrence_id,
            input_revision_hash=existing.input_revision_hash,
            sections=existing.sections,
            objective=existing.objective,
            edited_by=existing.edited_by,
            version=existing.version,
        )

    sections = _build_sections(occurrence.title, memory, body.objective)
    # Serialize version allocation across edits and generation requests.
    db.execute(
        select(CalendarOccurrence.id)
        .where(CalendarOccurrence.id == occurrence_id)
        .with_for_update()
    ).scalar_one()
    previous = db.scalar(
        select(AgendaVersion)
        .where(AgendaVersion.org_id == org_id, AgendaVersion.occurrence_id == occurrence_id)
        .order_by(AgendaVersion.version.desc())
        .limit(1)
    )
    agenda = AgendaVersion(
        org_id=org_id,
        occurrence_id=occurrence_id,
        input_revision_hash=rev_hash,
        sections=sections,
        objective=body.objective,
        edited_by=None,
        version=(previous.version + 1) if previous else 1,
    )
    db.add(agenda)
    db.commit()
    return AgendaView(
        id=agenda.id,
        occurrence_id=agenda.occurrence_id,
        input_revision_hash=agenda.input_revision_hash,
        sections=agenda.sections,
        objective=agenda.objective,
        edited_by=agenda.edited_by,
        version=agenda.version,
    )


@router.get("/occurrences/{occurrence_id}/agenda", response_model=AgendaView)
def get_agenda(
    org_id: str,
    occurrence_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> AgendaView:
    """Return the latest agenda version for an occurrence."""
    _require_org(db, org_id)
    occurrence = _occurrence(db, org_id, occurrence_id)
    _require_occurrence_access(db, org_id, occurrence, user.id)

    agenda = db.execute(
        select(AgendaVersion)
        .where(AgendaVersion.occurrence_id == occurrence_id)
        .order_by(AgendaVersion.version.desc())
        .limit(1)
    ).scalar_one_or_none()
    if agenda is None:
        raise HTTPException(404, "no agenda for this occurrence")

    return AgendaView(
        id=agenda.id,
        occurrence_id=agenda.occurrence_id,
        input_revision_hash=agenda.input_revision_hash,
        sections=agenda.sections,
        objective=agenda.objective,
        edited_by=agenda.edited_by,
        version=agenda.version,
    )


@router.patch("/agendas/{agenda_id}", response_model=AgendaView)
def update_agenda(
    org_id: str,
    agenda_id: str,
    body: AgendaUpdateIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> AgendaView:
    """Save user edits to an agenda.  Optimistic version check; marks edited_by."""
    _require_org(db, org_id)
    agenda = db.execute(
        select(AgendaVersion).where(
            AgendaVersion.id == agenda_id,
            AgendaVersion.org_id == org_id,
        )
    ).scalar_one_or_none()
    if agenda is None:
        raise HTTPException(404, "agenda not found")

    occurrence = _occurrence(db, org_id, agenda.occurrence_id)
    _require_occurrence_access(db, org_id, occurrence, user.id, edit=True)
    db.execute(
        select(CalendarOccurrence.id)
        .where(CalendarOccurrence.id == occurrence.id)
        .with_for_update()
    ).scalar_one()

    if agenda.version != body.version:
        raise HTTPException(409, "version conflict")

    agenda.sections = [s.model_dump() for s in body.sections]
    if body.objective is not None:
        agenda.objective = body.objective
    agenda.edited_by = user.id
    agenda.version += 1
    db.commit()

    return AgendaView(
        id=agenda.id,
        occurrence_id=agenda.occurrence_id,
        input_revision_hash=agenda.input_revision_hash,
        sections=agenda.sections,
        objective=agenda.objective,
        edited_by=agenda.edited_by,
        version=agenda.version,
    )
