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
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import dependency as auth_dep
from app.auth.dependency import get_current_user, require_org_member
from app.db.base import get_db
from app.db.models import (
    CaptureSession,
    Correction,
    GlossaryTerm,
    KnowledgeItem,
    Person,
    SessionSpeaker,
    SpeakerResolution,
    User,
    Utterance,
)
from app.speakers.identity import recompute_voiceprint

router = APIRouter(prefix="/api/v1", tags=["corrections"])


class UtteranceOut(BaseModel):
    id: str
    start_s: float
    end_s: float
    text: str
    lang_tags: list[str]
    speaker: str
    speaker_cluster_id: str | None = None
    session_speaker_id: str | None = None
    person_id: str | None = None
    attribution_confidence: float
    asr_confidence: float
    repaired: bool


@router.get("/meetings/{capture_session_id}/utterances", response_model=list[UtteranceOut])
async def list_utterances(
    capture_session_id: str, db: Session = Depends(get_db)
) -> list[UtteranceOut]:
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
    speakers = {
        row.cluster_id: row
        for row in db.execute(
            select(SessionSpeaker).where(SessionSpeaker.capture_session_id == capture_session_id)
        )
        .scalars()
        .all()
    }
    for utt in utterances:
        speaker = "Unknown speaker"
        if utt.person_id:
            person = db.get(Person, utt.person_id)
            if person is not None:
                speaker = person.display_name
        session_speaker = speakers.get(utt.speaker_cluster_id or "")
        out.append(
            UtteranceOut(
                id=utt.id,
                start_s=utt.start_s,
                end_s=utt.end_s,
                text=utt.text,
                lang_tags=list(utt.lang_tags or []),
                speaker=speaker,
                speaker_cluster_id=utt.speaker_cluster_id,
                session_speaker_id=session_speaker.id if session_speaker is not None else None,
                person_id=utt.person_id,
                attribution_confidence=utt.attribution_confidence,
                asr_confidence=utt.asr_confidence,
                repaired=utt.repaired,
            )
        )
    return out


class PersonOptionOut(BaseModel):
    id: str
    display_name: str
    email: str | None = None


class SessionSpeakerOut(BaseModel):
    id: str
    cluster_id: str
    person_id: str | None = None
    display_name: str | None = None
    resolution_method: str
    confidence: float
    utterance_count: int


class MeetingSpeakersOut(BaseModel):
    people: list[PersonOptionOut]
    speakers: list[SessionSpeakerOut]


@router.get("/meetings/{capture_session_id}/speakers", response_model=MeetingSpeakersOut)
async def list_meeting_speakers(
    capture_session_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MeetingSpeakersOut:
    session = db.get(CaptureSession, capture_session_id)
    if session is None:
        raise HTTPException(404, "capture session not found")
    if not auth_dep.is_org_member(db, session.org_id, user):
        raise HTTPException(403, "not a member of this org")

    people = (
        db.execute(
            select(Person).where(Person.org_id == session.org_id).order_by(Person.display_name)
        )
        .scalars()
        .all()
    )
    speakers = (
        db.execute(
            select(SessionSpeaker)
            .where(SessionSpeaker.capture_session_id == capture_session_id)
            .order_by(SessionSpeaker.cluster_id)
        )
        .scalars()
        .all()
    )
    person_by_id = {person.id: person for person in people}
    counts: dict[str, int] = {}
    for utt in db.query(Utterance).filter(Utterance.capture_session_id == capture_session_id).all():
        if utt.speaker_cluster_id:
            counts[utt.speaker_cluster_id] = counts.get(utt.speaker_cluster_id, 0) + 1

    return MeetingSpeakersOut(
        people=[
            PersonOptionOut(id=person.id, display_name=person.display_name, email=person.email)
            for person in people
        ],
        speakers=[
            SessionSpeakerOut(
                id=speaker.id,
                cluster_id=speaker.cluster_id,
                person_id=speaker.person_id,
                display_name=(
                    person_by_id[speaker.person_id].display_name
                    if speaker.person_id in person_by_id
                    else None
                ),
                resolution_method=speaker.resolution_method.value,
                confidence=speaker.confidence,
                utterance_count=counts.get(speaker.cluster_id, 0),
            )
            for speaker in speakers
        ],
    )


class SpeakerCorrectionRequest(BaseModel):
    person_id: str | None = None


class SpeakerCorrectionOut(BaseModel):
    session_speaker_id: str
    person_id: str | None = None
    display_name: str | None = None
    utterance_ids: list[str]
    updated_owner_item_ids: list[str]


@router.post(
    "/meetings/{capture_session_id}/speakers/{session_speaker_id}",
    response_model=SpeakerCorrectionOut,
)
async def correct_session_speaker(
    capture_session_id: str,
    session_speaker_id: str,
    req: SpeakerCorrectionRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SpeakerCorrectionOut:
    session = db.get(CaptureSession, capture_session_id)
    if session is None:
        raise HTTPException(404, "capture session not found")
    if not auth_dep.is_org_member(db, session.org_id, user):
        raise HTTPException(403, "not a member of this org")

    speaker = db.get(SessionSpeaker, session_speaker_id)
    if speaker is None or speaker.capture_session_id != capture_session_id:
        raise HTTPException(404, "session speaker not found")

    person = None
    if req.person_id is not None:
        person = db.get(Person, req.person_id)
        if person is None or person.org_id != session.org_id:
            raise HTTPException(400, "person_id must belong to this org")

    previous_person_id = speaker.person_id
    speaker.person_id = person.id if person is not None else None
    speaker.resolution_method = (
        SpeakerResolution.MANUAL if person is not None else SpeakerResolution.UNRESOLVED
    )
    speaker.confidence = 1.0 if person is not None else 0.0

    affected_utterances = (
        db.execute(
            select(Utterance).where(
                Utterance.capture_session_id == capture_session_id,
                Utterance.speaker_cluster_id == speaker.cluster_id,
            )
        )
        .scalars()
        .all()
    )
    affected_ids = [utt.id for utt in affected_utterances]
    for utt in affected_utterances:
        utt.person_id = person.id if person is not None else None
        utt.attribution_confidence = 1.0 if person is not None else 0.0

    updated_owner_item_ids: list[str] = []
    if affected_ids:
        owned_items = (
            db.execute(
                select(KnowledgeItem).where(
                    KnowledgeItem.owner_utterance_id.in_(affected_ids),
                    KnowledgeItem.owner_source.in_(["speaker", "speaker_candidate"]),
                )
            )
            .scalars()
            .all()
        )
        for item in owned_items:
            if person is None:
                item.owner_person_id = None
                item.owner_candidate_person_id = None
                item.owner_attribution_confidence = 0.0
            else:
                item.owner_person_id = person.id
                item.owner_candidate_person_id = None
                item.owner_attribution_confidence = 1.0
                item.owner_source = "speaker"
            updated_owner_item_ids.append(item.id)

    db.flush()
    recompute_targets = {previous_person_id, speaker.person_id} - {None}
    for person_id in recompute_targets:
        recompute_voiceprint(db, person_id)
    db.commit()

    return SpeakerCorrectionOut(
        session_speaker_id=speaker.id,
        person_id=speaker.person_id,
        display_name=person.display_name if person is not None else None,
        utterance_ids=affected_ids,
        updated_owner_item_ids=updated_owner_item_ids,
    )


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
            GlossaryTermOut(
                id=t.id, term=t.term, added_by=added_by, created_at=t.created_at.isoformat()
            )
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
    return GlossaryTermOut(
        id=row.id, term=row.term, added_by=added_by, created_at=row.created_at.isoformat()
    )


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
