"""Correction & glossary UI backend — POST /api/v1/corrections, glossary CRUD.

Product feature now, strategic asset forever (docs/PROJECT_PLAN.md § Correction
& glossary UI): every fix improves the org's LLM repair pass immediately
(app/asr/repair.py's `glossary_terms`, sourced here — see
app/orchestrator/worker.py's `_repair_context`) and, with explicit
`training_consent`, accrues into the only si-ta-en code-switched meeting
corpus in existence.

A correction updates `Utterance.text` in place — the corrected text is what
every downstream reader (report, chat, future re-runs of understand/verify)
sees from that point on. The original text is preserved on the `Correction`
row itself, not lost.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import dependency as auth_dep
from app.auth.dependency import get_current_user, require_org_member
from app.db.base import get_db
from app.db.models import CaptureSession, Correction, GlossaryTerm, Person, User, Utterance

router = APIRouter(prefix="/api/v1", tags=["corrections"])


class UtteranceOut(BaseModel):
    id: str
    start_s: float
    end_s: float
    text: str
    lang_tags: list[str]
    speaker: str
    asr_confidence: float
    repaired: bool


@router.get("/meetings/{capture_session_id}/utterances", response_model=list[UtteranceOut])
async def list_utterances(capture_session_id: str, db: Session = Depends(get_db)) -> list[UtteranceOut]:
    session = db.get(CaptureSession, capture_session_id)
    if session is None:
        raise HTTPException(404, "capture session not found")

    utterances = (
        db.query(Utterance)
        .filter(Utterance.capture_session_id == capture_session_id)
        .order_by(Utterance.start_s)
        .all()
    )
    out: list[UtteranceOut] = []
    for utt in utterances:
        speaker = "Unknown speaker"
        if utt.person_id:
            person = db.get(Person, utt.person_id)
            if person is not None:
                speaker = person.display_name
        out.append(
            UtteranceOut(
                id=utt.id,
                start_s=utt.start_s,
                end_s=utt.end_s,
                text=utt.text,
                lang_tags=list(utt.lang_tags or []),
                speaker=speaker,
                asr_confidence=utt.asr_confidence,
                repaired=utt.repaired,
            )
        )
    return out


class CorrectionRequest(BaseModel):
    utterance_id: str
    corrected_text: str
    training_consent: bool = False
    corrected_by_person_id: str | None = None
    # Optional: also remember this term for future LLM repair passes on this
    # org's meetings (e.g. a ticket ID or name the ASR keeps mangling).
    glossary_term: str | None = None


class CorrectionOut(BaseModel):
    id: str
    utterance_id: str
    original_text: str
    corrected_text: str
    glossary_term_id: str | None = None


@router.post("/corrections", response_model=CorrectionOut)
async def submit_correction(
    req: CorrectionRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CorrectionOut:
    utterance = db.get(Utterance, req.utterance_id)
    if utterance is None:
        raise HTTPException(404, "utterance not found")
    # org_id only exists on the looked-up utterance, not the request body
    # itself -- same reasoning as chat.py/actions.py's approve/reject.
    if not auth_dep.is_org_member(db, utterance.org_id, user):
        raise HTTPException(403, "not a member of this org")

    corrected_text = req.corrected_text.strip()
    if not corrected_text:
        raise HTTPException(400, "corrected_text must not be empty")

    correction = Correction(
        org_id=utterance.org_id,
        utterance_id=utterance.id,
        corrected_by_person_id=req.corrected_by_person_id,
        original_text=utterance.text,
        corrected_text=corrected_text,
        training_consent=req.training_consent,
    )
    db.add(correction)
    db.flush()

    utterance.text = corrected_text

    glossary_term_id = None
    term = (req.glossary_term or "").strip()
    if term:
        glossary_row = GlossaryTerm(
            org_id=utterance.org_id,
            term=term,
            added_by_person_id=req.corrected_by_person_id,
            source_correction_id=correction.id,
        )
        db.add(glossary_row)
        db.flush()
        glossary_term_id = glossary_row.id

    db.commit()

    return CorrectionOut(
        id=correction.id,
        utterance_id=utterance.id,
        original_text=correction.original_text,
        corrected_text=correction.corrected_text,
        glossary_term_id=glossary_term_id,
    )


class GlossaryTermOut(BaseModel):
    id: str
    term: str
    added_by: str | None = None
    created_at: str


@router.get("/orgs/{org_id}/glossary", response_model=list[GlossaryTermOut])
async def list_glossary(
    org_id: str, db: Session = Depends(get_db), _: None = Depends(require_org_member)
) -> list[GlossaryTermOut]:
    terms = (
        db.query(GlossaryTerm)
        .filter(GlossaryTerm.org_id == org_id)
        .order_by(GlossaryTerm.created_at.desc())
        .all()
    )
    out: list[GlossaryTermOut] = []
    for t in terms:
        added_by = None
        if t.added_by_person_id:
            person = db.get(Person, t.added_by_person_id)
            added_by = person.display_name if person else None
        out.append(
            GlossaryTermOut(id=t.id, term=t.term, added_by=added_by, created_at=t.created_at.isoformat())
        )
    return out


class AddGlossaryTermRequest(BaseModel):
    term: str
    added_by_person_id: str | None = None


@router.post("/orgs/{org_id}/glossary", response_model=GlossaryTermOut)
async def add_glossary_term(
    org_id: str,
    req: AddGlossaryTermRequest,
    db: Session = Depends(get_db),
    _: None = Depends(require_org_member),
) -> GlossaryTermOut:
    term = req.term.strip()
    if not term:
        raise HTTPException(400, "term must not be empty")

    row = GlossaryTerm(org_id=org_id, term=term, added_by_person_id=req.added_by_person_id)
    db.add(row)
    db.commit()

    added_by = None
    if row.added_by_person_id:
        person = db.get(Person, row.added_by_person_id)
        added_by = person.display_name if person else None
    return GlossaryTermOut(id=row.id, term=row.term, added_by=added_by, created_at=row.created_at.isoformat())


@router.delete("/orgs/{org_id}/glossary/{term_id}", status_code=204)
async def delete_glossary_term(
    org_id: str,
    term_id: str,
    db: Session = Depends(get_db),
    _: None = Depends(require_org_member),
) -> None:
    row = db.get(GlossaryTerm, term_id)
    if row is None or row.org_id != org_id:
        raise HTTPException(404, "glossary term not found")
    db.delete(row)
    db.commit()
