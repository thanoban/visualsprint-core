"""GET /api/v1/me -- resolves the authenticated caller to their user + org.

Replaces the old dev-convenience GET /orgs/default (app/api/corrections.py),
which every frontend page called to resolve a hardcoded "default" org name
with no auth at all. This slice doesn't support multi-org membership UI yet,
so "the org" is simply the caller's personal org from app.auth.dependency's
first-login auto-create -- see that module's docstring.
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth.dependency import get_current_user
from app.db.base import get_db
from app.db.models import Org, OrgMember, User

router = APIRouter(prefix="/api/v1", tags=["me"])


class UserOut(BaseModel):
    id: str
    email: str
    display_name: str | None


class OrgOut(BaseModel):
    id: str
    name: str


class MeOut(BaseModel):
    user: UserOut
    org: OrgOut


@router.get("/me", response_model=MeOut)
async def get_me(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> MeOut:
    member = db.query(OrgMember).filter(OrgMember.user_id == user.id).one()
    org = db.get(Org, member.org_id)
    return MeOut(
        user=UserOut(id=user.id, email=user.email, display_name=user.display_name),
        org=OrgOut(id=org.id, name=org.name),
    )
