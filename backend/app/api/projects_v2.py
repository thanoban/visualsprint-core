"""Customer directory, private project and meeting assignment APIs."""

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.dependency import get_current_user, require_org_admin, require_org_member
from app.db.base import get_db
from app.db.models import (
    Customer,
    CustomerContact,
    CustomerStatus,
    Meeting,
    MeetingAssignment,
    MeetingAssignmentSource,
    OrgMember,
    Project,
    ProjectMember,
    ProjectRole,
    ProjectStatus,
    User,
)

router = APIRouter(prefix="/api/v2/workspaces/{org_id}", tags=["projects-v2"])


class CustomerCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=255)


class CustomerView(BaseModel):
    id: str
    name: str
    status: str
    version: int
    visible_project_count: int


class ContactCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: str = Field(
        min_length=3,
        max_length=320,
        pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$",
    )
    display_name: str | None = Field(default=None, max_length=255)
    verified_rule: bool = False


class ContactView(BaseModel):
    id: str
    customer_id: str
    email: str
    display_name: str | None
    verified_rule: bool


class ProjectCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=255)
    customer_id: str | None = Field(default=None, max_length=36)


class ProjectUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=255)
    customer_id: str | None = Field(default=None, max_length=36)
    status: str | None = None


class ProjectView(BaseModel):
    id: str
    name: str
    customer_id: str | None
    visibility: str
    status: str
    version: int
    role: str


class ProjectMemberUpsert(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: str = Field(min_length=1)
    role: str


class ProjectMemberView(BaseModel):
    user_id: str
    role: str
    email: str | None = None


def _customer_view(db: Session, customer: Customer, user_id: str) -> CustomerView:
    count = db.scalar(
        select(func.count())
        .select_from(Project)
        .join(ProjectMember, ProjectMember.project_id == Project.id)
        .where(
            Project.org_id == customer.org_id,
            Project.customer_id == customer.id,
            ProjectMember.user_id == user_id,
        )
    )
    return CustomerView(
        id=customer.id,
        name=customer.name,
        status=customer.status.value,
        version=customer.version,
        visible_project_count=int(count or 0),
    )


def _membership(db: Session, org_id: str, project_id: str, user_id: str) -> ProjectMember:
    member = db.execute(
        select(ProjectMember).where(
            ProjectMember.org_id == org_id,
            ProjectMember.project_id == project_id,
            ProjectMember.user_id == user_id,
        )
    ).scalar_one_or_none()
    if member is None:
        raise HTTPException(404, "project not found")
    return member


def _project_view(project: Project, member: ProjectMember) -> ProjectView:
    return ProjectView(
        id=project.id,
        name=project.name,
        customer_id=project.customer_id,
        visibility=project.visibility.value,
        status=project.status.value,
        version=project.version,
        role=member.role.value,
    )


@router.post("/customers", response_model=CustomerView, status_code=201)
def create_customer(
    org_id: str,
    body: CustomerCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> CustomerView:
    name = body.name.strip()
    if not name:
        raise HTTPException(422, "customer name is required")
    customer = Customer(org_id=org_id, name=name)
    db.add(customer)
    db.commit()
    return _customer_view(db, customer, user.id)


@router.get("/customers", response_model=list[CustomerView])
def list_customers(
    org_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> list[CustomerView]:
    customers = db.scalars(
        select(Customer).where(Customer.org_id == org_id).order_by(Customer.name, Customer.id)
    ).all()
    return [_customer_view(db, customer, user.id) for customer in customers]


@router.post("/customers/{customer_id}/archive", response_model=CustomerView)
def archive_customer(
    org_id: str,
    customer_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_org_admin),
) -> CustomerView:
    customer = db.execute(
        select(Customer).where(Customer.org_id == org_id, Customer.id == customer_id)
    ).scalar_one_or_none()
    if customer is None:
        raise HTTPException(404, "customer not found")
    customer.status = CustomerStatus.ARCHIVED
    customer.version += 1
    db.commit()
    return _customer_view(db, customer, user.id)


@router.post("/customers/{customer_id}/contacts", response_model=ContactView, status_code=201)
def create_contact(
    org_id: str,
    customer_id: str,
    body: ContactCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_org_admin),
) -> ContactView:
    customer = db.execute(
        select(Customer).where(Customer.org_id == org_id, Customer.id == customer_id)
    ).scalar_one_or_none()
    if customer is None:
        raise HTTPException(404, "customer not found")
    normalized = str(body.email).strip().lower()
    exists = db.execute(
        select(CustomerContact.id).where(
            CustomerContact.customer_id == customer.id,
            CustomerContact.email == normalized,
        )
    ).scalar_one_or_none()
    if exists is not None:
        raise HTTPException(409, "contact email already exists for this customer")
    contact = CustomerContact(
        org_id=org_id,
        customer_id=customer.id,
        email=normalized,
        display_name=body.display_name.strip() if body.display_name else None,
        verified_rule=body.verified_rule,
    )
    db.add(contact)
    db.commit()
    return ContactView.model_validate(contact, from_attributes=True)


@router.post("/projects", response_model=ProjectView, status_code=201)
def create_project(
    org_id: str,
    body: ProjectCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> ProjectView:
    name = body.name.strip()
    if not name:
        raise HTTPException(422, "project name is required")
    if body.customer_id is not None:
        customer = db.execute(
            select(Customer).where(Customer.org_id == org_id, Customer.id == body.customer_id)
        ).scalar_one_or_none()
        if customer is None or customer.status != CustomerStatus.ACTIVE:
            raise HTTPException(404, "active customer not found")
    project = Project(org_id=org_id, customer_id=body.customer_id, name=name)
    db.add(project)
    db.flush()
    membership = ProjectMember(
        org_id=org_id, project_id=project.id, user_id=user.id, role=ProjectRole.OWNER
    )
    db.add(membership)
    db.commit()
    return _project_view(project, membership)


@router.get("/projects", response_model=list[ProjectView])
def list_projects(
    org_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> list[ProjectView]:
    rows = db.execute(
        select(Project, ProjectMember)
        .join(ProjectMember, ProjectMember.project_id == Project.id)
        .where(Project.org_id == org_id, ProjectMember.user_id == user.id)
        .order_by(Project.name, Project.id)
    ).all()
    return [_project_view(project, member) for project, member in rows]


@router.patch("/projects/{project_id}", response_model=ProjectView)
def update_project(
    org_id: str,
    project_id: str,
    body: ProjectUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> ProjectView:
    member = _membership(db, org_id, project_id, user.id)
    if member.role != ProjectRole.OWNER:
        raise HTTPException(403, "project owner required")
    project = db.execute(
        select(Project).where(Project.org_id == org_id, Project.id == project_id).with_for_update()
    ).scalar_one()
    if project.version != body.version:
        raise HTTPException(409, "project version mismatch")
    if body.name is not None:
        if not body.name.strip():
            raise HTTPException(422, "project name is required")
        project.name = body.name.strip()
    if "customer_id" in body.model_fields_set:
        if body.customer_id is not None:
            customer = db.execute(
                select(Customer).where(
                    Customer.org_id == org_id,
                    Customer.id == body.customer_id,
                    Customer.status == CustomerStatus.ACTIVE,
                )
            ).scalar_one_or_none()
            if customer is None:
                raise HTTPException(404, "active customer not found")
        project.customer_id = body.customer_id
    if body.status is not None:
        if body.status != "archived":
            raise HTTPException(422, "only archived is accepted as a status transition")
        project.status = ProjectStatus.ARCHIVED
    project.version += 1
    db.commit()
    return _project_view(project, member)


@router.get("/projects/{project_id}", response_model=ProjectView)
def get_project(
    org_id: str,
    project_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> ProjectView:
    member = _membership(db, org_id, project_id, user.id)
    project = db.scalar(select(Project).where(Project.org_id == org_id, Project.id == project_id))
    if project is None:
        raise HTTPException(404, "project not found")
    return _project_view(project, member)


@router.get("/projects/{project_id}/members", response_model=list[ProjectMemberView])
def list_project_members(
    org_id: str,
    project_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> list[ProjectMemberView]:
    _membership(db, org_id, project_id, user.id)
    rows = db.execute(
        select(ProjectMember, User.email)
        .join(User, User.id == ProjectMember.user_id)
        .join(
            OrgMember,
            (OrgMember.user_id == ProjectMember.user_id) & (OrgMember.org_id == org_id),
        )
        .where(ProjectMember.org_id == org_id, ProjectMember.project_id == project_id)
        .order_by(ProjectMember.created_at, ProjectMember.user_id)
        .limit(100)
    ).all()
    return [
        ProjectMemberView(user_id=member.user_id, role=member.role.value, email=email)
        for member, email in rows
    ]


@router.put("/projects/{project_id}/members", response_model=ProjectMemberView)
def upsert_project_member(
    org_id: str,
    project_id: str,
    body: ProjectMemberUpsert,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> ProjectMemberView:
    owner = _membership(db, org_id, project_id, user.id)
    db.execute(
        select(Project.id)
        .where(Project.org_id == org_id, Project.id == project_id)
        .with_for_update()
    ).scalar_one()
    if owner.role != ProjectRole.OWNER:
        raise HTTPException(403, "project owner required")
    try:
        role = ProjectRole(body.role)
    except ValueError as exc:
        raise HTTPException(422, "role must be owner, editor, or viewer") from exc
    workspace_member = db.execute(
        select(OrgMember.id).where(OrgMember.org_id == org_id, OrgMember.user_id == body.user_id)
    ).scalar_one_or_none()
    if workspace_member is None:
        raise HTTPException(404, "workspace member not found")
    membership = db.execute(
        select(ProjectMember).where(
            ProjectMember.project_id == project_id, ProjectMember.user_id == body.user_id
        )
    ).scalar_one_or_none()
    if membership is None:
        membership = ProjectMember(
            org_id=org_id, project_id=project_id, user_id=body.user_id, role=role
        )
        db.add(membership)
    else:
        if membership.role == ProjectRole.OWNER and role != ProjectRole.OWNER:
            owners = db.scalar(
                select(func.count())
                .select_from(ProjectMember)
                .where(
                    ProjectMember.project_id == project_id,
                    ProjectMember.role == ProjectRole.OWNER,
                )
            )
            if int(owners or 0) <= 1:
                raise HTTPException(409, "project must retain at least one owner")
        membership.role = role
    db.commit()
    return ProjectMemberView(user_id=membership.user_id, role=membership.role.value)


@router.delete("/projects/{project_id}/members/{member_user_id}", status_code=204)
def remove_project_member(
    org_id: str,
    project_id: str,
    member_user_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> Response:
    owner = _membership(db, org_id, project_id, user.id)
    db.execute(
        select(Project.id)
        .where(Project.org_id == org_id, Project.id == project_id)
        .with_for_update()
    ).scalar_one()
    if owner.role != ProjectRole.OWNER:
        raise HTTPException(403, "project owner required")
    target = db.execute(
        select(ProjectMember).where(
            ProjectMember.org_id == org_id,
            ProjectMember.project_id == project_id,
            ProjectMember.user_id == member_user_id,
        )
    ).scalar_one_or_none()
    if target is None:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    if target.role == ProjectRole.OWNER:
        owners = db.scalar(
            select(func.count())
            .select_from(ProjectMember)
            .where(
                ProjectMember.project_id == project_id,
                ProjectMember.role == ProjectRole.OWNER,
            )
        )
        if int(owners or 0) <= 1:
            raise HTTPException(409, "project must retain at least one owner")
    db.delete(target)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --------------------------------------------------------------------------- #
# F08 — Meeting assignment
# --------------------------------------------------------------------------- #


class AssignmentIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project_id: str = Field(min_length=1, max_length=36)
    version: int | None = Field(default=None, ge=0)


class AssignmentView(BaseModel):
    id: str
    meeting_id: str
    project_id: str
    source: str
    version: int


class ProjectMeetingListItem(BaseModel):
    meeting_id: str
    title: str
    platform: str
    scheduled_start: str | None = None
    source: str


@router.put("/meetings/{meeting_id}/assignment", response_model=AssignmentView)
def assign_meeting(
    org_id: str,
    meeting_id: str,
    body: AssignmentIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> AssignmentView:
    """Assign or move a meeting to a project.

    The meeting owner must have edit access to both source and target.
    A supplied version prevents a stale screen from sharing a newer assignment.
    """
    meeting = db.scalar(
        select(Meeting)
        .where(Meeting.id == meeting_id, Meeting.org_id == org_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if meeting is None or meeting.org_id != org_id:
        raise HTTPException(404, "meeting not found")
    if meeting.owner_user_id != user.id:
        raise HTTPException(404, "owned meeting not found")

    project = db.get(Project, body.project_id)
    if project is None or project.org_id != org_id:
        raise HTTPException(404, "project not found")
    if project.status != ProjectStatus.ACTIVE:
        raise HTTPException(409, "archived projects do not accept new assignments")

    # Caller must be a member of the target project.
    target_member = db.execute(
        select(ProjectMember).where(
            ProjectMember.org_id == org_id,
            ProjectMember.project_id == body.project_id,
            ProjectMember.user_id == user.id,
        )
    ).scalar_one_or_none()
    if target_member is None:
        raise HTTPException(404, "project not found")
    if target_member.role not in {ProjectRole.OWNER, ProjectRole.EDITOR}:
        raise HTTPException(403, "project edit access required")

    existing = db.execute(
        select(MeetingAssignment).where(MeetingAssignment.meeting_id == meeting_id)
    ).scalar_one_or_none()

    if body.version is not None and body.version != (existing.version if existing else 0):
        raise HTTPException(409, "assignment changed; reload before sharing this meeting")

    if existing is not None:
        if existing.project_id == body.project_id:
            # Already assigned to this project — idempotent.
            return AssignmentView(
                id=existing.id,
                meeting_id=meeting_id,
                project_id=existing.project_id,
                source=existing.source.value,
                version=existing.version,
            )
        # Moving to a different project — caller must be a member of the source project too.
        source_member = db.execute(
            select(ProjectMember).where(
                ProjectMember.org_id == org_id,
                ProjectMember.project_id == existing.project_id,
                ProjectMember.user_id == user.id,
            )
        ).scalar_one_or_none()
        if source_member is None:
            raise HTTPException(403, "must be a member of the source project to move a meeting")
        if source_member.role not in {ProjectRole.OWNER, ProjectRole.EDITOR}:
            raise HTTPException(403, "source project edit access required")
        existing.project_id = body.project_id
        existing.assigned_by = user.id
        existing.source = MeetingAssignmentSource.MANUAL
        existing.version += 1
        db.commit()
        return AssignmentView(
            id=existing.id,
            meeting_id=meeting_id,
            project_id=existing.project_id,
            source=existing.source.value,
            version=existing.version,
        )

    assignment = MeetingAssignment(
        org_id=org_id,
        meeting_id=meeting_id,
        project_id=body.project_id,
        assigned_by=user.id,
        source=MeetingAssignmentSource.MANUAL,
    )
    db.add(assignment)
    db.commit()
    return AssignmentView(
        id=assignment.id,
        meeting_id=meeting_id,
        project_id=assignment.project_id,
        source=assignment.source.value,
        version=assignment.version,
    )


@router.delete("/meetings/{meeting_id}/assignment", status_code=204)
def unassign_meeting(
    org_id: str,
    meeting_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
    version: int | None = None,
) -> Response:
    """Return an owned meeting to the private inbox with source-project edit access."""
    meeting = db.scalar(
        select(Meeting)
        .where(Meeting.id == meeting_id, Meeting.org_id == org_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if meeting is None or meeting.org_id != org_id:
        raise HTTPException(404, "meeting not found")
    if meeting.owner_user_id != user.id:
        raise HTTPException(404, "owned meeting not found")

    existing = db.execute(
        select(MeetingAssignment).where(MeetingAssignment.meeting_id == meeting_id)
    ).scalar_one_or_none()
    if existing is None:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    if version is not None and version != existing.version:
        raise HTTPException(409, "assignment changed; reload before removing it")

    member = db.execute(
        select(ProjectMember).where(
            ProjectMember.org_id == org_id,
            ProjectMember.project_id == existing.project_id,
            ProjectMember.user_id == user.id,
        )
    ).scalar_one_or_none()
    if member is None:
        raise HTTPException(404, "project not found")
    if member.role not in {ProjectRole.OWNER, ProjectRole.EDITOR}:
        raise HTTPException(403, "project edit access required")

    db.delete(existing)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/projects/{project_id}/meetings", response_model=list[ProjectMeetingListItem])
def list_project_meetings(
    org_id: str,
    project_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> list[ProjectMeetingListItem]:
    """List meetings assigned to this project.  Only project members can access."""
    _membership(db, org_id, project_id, user.id)

    rows = db.execute(
        select(MeetingAssignment, Meeting)
        .join(Meeting, Meeting.id == MeetingAssignment.meeting_id)
        .where(
            MeetingAssignment.org_id == org_id,
            MeetingAssignment.project_id == project_id,
        )
        .order_by(Meeting.scheduled_start.desc())
    ).all()

    return [
        ProjectMeetingListItem(
            meeting_id=meeting.id,
            title=meeting.title or "Untitled meeting",
            platform=meeting.platform,
            scheduled_start=meeting.scheduled_start.isoformat()
            if meeting.scheduled_start
            else None,
            source=assignment.source.value,
        )
        for assignment, meeting in rows
    ]
