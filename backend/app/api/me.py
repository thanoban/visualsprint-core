"""GET /api/v1/me -- resolves the authenticated caller to their user + org.

Replaces the old dev-convenience GET /orgs/default (app/api/corrections.py),
which every frontend page called to resolve a hardcoded "default" org name
with no auth at all. This slice doesn't support multi-org membership UI yet,
so "the org" is simply the caller's personal org from app.auth.dependency's
first-login auto-create -- see that module's docstring.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth.dependency import get_current_user
from app.db.base import get_db
from app.db.models import Org, OrgMember, Person, User

router = APIRouter(prefix="/api/v1", tags=["me"])


class UserOut(BaseModel):
    id: str
    email: str
    display_name: str | None


class OrgOut(BaseModel):
    id: str
    name: str


class PersonOut(BaseModel):
    id: str
    display_name: str
    email: str | None = None


class MeOut(BaseModel):
    user: UserOut
    org: OrgOut
    person: PersonOut | None = None


@router.get("/me", response_model=MeOut)
async def get_me(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> MeOut:
    member = (
        db.query(OrgMember)
        .join(Org, Org.id == OrgMember.org_id)
        .filter(OrgMember.user_id == user.id, Org.deleted_at.is_(None))
        .order_by(OrgMember.created_at, OrgMember.id)
        .first()
    )
    if member is None:
        raise HTTPException(404, "no active workspace; deletion receipts remain available")
    org = db.get(Org, member.org_id)
    if org is None:
        raise HTTPException(404, "workspace not found")
    email_matches = (
        db.query(Person).filter(Person.org_id == org.id, Person.email == user.email).all()
    )
    person = email_matches[0] if len(email_matches) == 1 else None
    if person is not None and person.user_id is None:
        person.user_id = user.id
        db.commit()
    return MeOut(
        user=UserOut(id=user.id, email=user.email, display_name=user.display_name),
        org=OrgOut(id=org.id, name=org.name),
        person=(
            PersonOut(id=person.id, display_name=person.display_name, email=person.email)
            if person is not None
            else None
        ),
    )
