"""POST /api/v1/leads -- public, unauthenticated form submission from the
marketing site (frontend/app/welcome)'s "Book a demo" and "Collaborate with
us" CTAs. No org exists yet for these visitors, so this intentionally sits
outside the org-scoped API surface everything else in this file uses --
same reasoning as the OAuth callback being the other unauthenticated route.
"""

import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

from app.db.base import get_db
from app.db.models import LandingLead, LeadKind

router = APIRouter(prefix="/api/v1", tags=["leads"])

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class LeadIn(BaseModel):
    kind: LeadKind
    name: str
    email: str
    company: str | None = None
    message: str | None = None

    @field_validator("name", "email")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("must not be blank")
        return v

    @field_validator("email")
    @classmethod
    def _looks_like_email(cls, v: str) -> str:
        if not _EMAIL_RE.match(v):
            raise ValueError("not a valid email address")
        return v


class LeadOut(BaseModel):
    id: str


@router.post("/leads", response_model=LeadOut, status_code=201)
async def create_lead(payload: LeadIn, db: Session = Depends(get_db)) -> LeadOut:
    lead = LandingLead(
        kind=payload.kind,
        name=payload.name,
        email=payload.email,
        company=payload.company.strip() if payload.company else None,
        message=payload.message.strip() if payload.message else None,
    )
    db.add(lead)
    try:
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(500, "failed to save submission") from exc
    return LeadOut(id=lead.id)
