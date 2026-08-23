"""FastAPI auth dependencies -- the enforcement boundary for every org-scoped
route. `get_current_user` verifies the caller's Supabase JWT and resolves it
to a local `User` row, creating one (plus a personal `Org` + `OrgMember`) on
first sight. `require_org_member` is what actually closes the gap that
existed before this module: every `org_id` path parameter used to be
unauthenticated -- any caller could act on any org_id.
"""

from fastapi import Depends, Header, HTTPException
from sqlalchemy.orm import Session

from app.auth.verify import AuthError, verify_jwt
from app.db.base import get_db
from app.db.models import CaptureSession, Org, OrgMember, Person, User


def _extract_bearer_token(authorization: str) -> str:
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(401, "expected 'Authorization: Bearer <token>'")
    return token


def get_current_user(
    authorization: str = Header(...),
    db: Session = Depends(get_db),
) -> User:
    token = _extract_bearer_token(authorization)
    try:
        claims = verify_jwt(token)
    except AuthError as exc:
        raise HTTPException(401, str(exc)) from exc

    user_id = str(claims["sub"])
    email = str(claims.get("email", ""))
    user = db.get(User, user_id)
    if user is None:
        # First-seen token -- this *is* signup: create the local User row
        # plus a personal Org they own, in the same request. No separate
        # signup-completion endpoint needed.
        user = User(id=user_id, email=email)
        db.add(user)
        org = Org(name=email or f"user-{user_id[:8]}")
        db.add(org)
        db.flush()
        db.add(OrgMember(org_id=org.id, user_id=user.id, role="owner"))
        # Create a Person record linked to this user so commitments and
        # decisions can be attributed to them across meetings.
        _meta = claims.get("user_metadata")
        _full_name = _meta.get("full_name", "") if isinstance(_meta, dict) else ""
        display_name = str(_full_name or email or user_id[:8])
        person = Person(org_id=org.id, user_id=user.id, display_name=display_name, email=email or None)
        db.add(person)
        db.commit()
    return user


def is_org_member(db: Session, org_id: str, user: User) -> bool:
    return (
        db.query(OrgMember)
        .filter(OrgMember.org_id == org_id, OrgMember.user_id == user.id)
        .one_or_none()
        is not None
    )


def require_org_member(
    org_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    """For routes where `org_id` is a path parameter -- FastAPI resolves it
    here the same way it resolves the endpoint's own path params, since this
    is used via `Depends(require_org_member)` on a route already declaring
    `{org_id}` in its path.

    Routes where org_id instead comes from a request body or form field
    (app/api/chat.py, app/api/upload.py, app/api/corrections.py's
    submit_correction) can't use this as a Depends -- call `is_org_member`
    directly inside the handler once the body/form has been parsed."""
    if not is_org_member(db, org_id, user):
        raise HTTPException(403, "not a member of this org")


def require_session_member(
    capture_session_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CaptureSession:
    """Resolve a capture session and prove the caller belongs to its org.

    Single enforcement point for every per-session read -- three routes
    (meeting report, raw utterance list, session-state poll) each took only
    a capture_session_id and checked nothing, so any caller holding a UUID
    could read another tenant's full meeting content. Returns the resolved
    CaptureSession so handlers cannot accidentally re-fetch it unchecked.
    """
    session = db.get(CaptureSession, capture_session_id)
    if session is None:
        raise HTTPException(404, "capture session not found")
    if not is_org_member(db, session.org_id, user):
        raise HTTPException(403, "not a member of this org")
    return session
