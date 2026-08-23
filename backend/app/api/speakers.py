"""Speaker identity review and correction endpoints.

GET  /api/v1/meetings/{session_id}/utterances  — transcript with speaker labels
GET  /api/v1/meetings/{session_id}/speakers    — diarized clusters + org people
POST /api/v1/meetings/{session_id}/speakers/{session_speaker_id}
     — correct one cluster → Person, re-attribute utterances + commitment owners
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.dependency import require_session_member
from app.db.base import get_db
from app.db.models import (
    CaptureSession,
    KnowledgeItem,
    KnowledgeType,
    Confidence,
    Person,
    SessionSpeaker,
    SpeakerResolution,
    Utterance,
)

router = APIRouter(prefix="/api/v1/meetings", tags=["speakers"])

MIN_OWNER_CONFIDENCE = 0.60


class UtteranceOut(BaseModel):
    id: str
    start_s: float
    end_s: float
    text: str
    lang_tags: list[str]
    speaker: str
    speaker_cluster_id: str | None
    session_speaker_id: str | None
    person_id: str | None
    attribution_confidence: float
    asr_confidence: float
    repaired: bool


class PersonOptionOut(BaseModel):
    id: str
    display_name: str
    email: str | None = None


class SessionSpeakerOut(BaseModel):
    id: str
    cluster_id: str
    person_id: str | None
    display_name: str | None
    resolution_method: str
    confidence: float
    utterance_count: int


class MeetingSpeakersOut(BaseModel):
    people: list[PersonOptionOut]
    speakers: list[SessionSpeakerOut]


class SpeakerCorrectionIn(BaseModel):
    person_id: str | None


class SpeakerCorrectionResponse(BaseModel):
    session_speaker_id: str
    person_id: str | None
    display_name: str | None
    utterance_ids: list[str]
    updated_owner_item_ids: list[str]


def _session_or_404(db: Session, capture_session_id: str) -> CaptureSession:
    session = db.get(CaptureSession, capture_session_id)
    if session is None:
        raise HTTPException(404, "capture session not found")
    return session


def _speaker_label(utterance: Utterance, people_by_id: dict[str, Person]) -> str:
    if utterance.person_id and utterance.person_id in people_by_id:
        return people_by_id[utterance.person_id].display_name
    if utterance.speaker_cluster_id:
        return utterance.speaker_cluster_id
    return "Unknown"


@router.get("/{capture_session_id}/utterances", response_model=list[UtteranceOut])
async def list_utterances(
    capture_session_id: str,
    db: Session = Depends(get_db),
    _: None = Depends(require_session_member),
) -> list[UtteranceOut]:
    _session_or_404(db, capture_session_id)
    utterances = (
        db.execute(
            select(Utterance)
            .where(Utterance.capture_session_id == capture_session_id)
            .order_by(Utterance.start_s)
        )
        .scalars()
        .all()
    )
    person_ids = {u.person_id for u in utterances if u.person_id}
    people_by_id: dict[str, Person] = {}
    if person_ids:
        people_by_id = {
            person.id: person
            for person in db.execute(
                select(Person).where(Person.id.in_(person_ids))
            ).scalars().all()
        }

    speakers_by_cluster: dict[str, SessionSpeaker] = {}
    session_speakers = (
        db.execute(
            select(SessionSpeaker).where(
                SessionSpeaker.capture_session_id == capture_session_id
            )
        )
        .scalars()
        .all()
    )
    for ss in session_speakers:
        speakers_by_cluster[ss.cluster_id] = ss

    rows: list[UtteranceOut] = []
    for u in utterances:
        ss = speakers_by_cluster.get(u.speaker_cluster_id or "") if u.speaker_cluster_id else None
        rows.append(
            UtteranceOut(
                id=u.id,
                start_s=u.start_s,
                end_s=u.end_s,
                text=u.text,
                lang_tags=u.lang_tags or [],
                speaker=_speaker_label(u, people_by_id),
                speaker_cluster_id=u.speaker_cluster_id,
                session_speaker_id=ss.id if ss else None,
                person_id=u.person_id,
                attribution_confidence=u.attribution_confidence,
                asr_confidence=u.asr_confidence,
                repaired=u.repaired,
            )
        )
    return rows


@router.get("/{capture_session_id}/speakers", response_model=MeetingSpeakersOut)
async def list_speakers(
    capture_session_id: str,
    db: Session = Depends(get_db),
    _: None = Depends(require_session_member),
) -> MeetingSpeakersOut:
    session = _session_or_404(db, capture_session_id)
    session_speakers = (
        db.execute(
            select(SessionSpeaker).where(
                SessionSpeaker.capture_session_id == capture_session_id
            )
        )
        .scalars()
        .all()
    )

    utterance_counts: dict[str, int] = {}
    for u in (
        db.execute(
            select(Utterance.speaker_cluster_id)
            .where(
                Utterance.capture_session_id == capture_session_id,
                Utterance.speaker_cluster_id.isnot(None),
            )
        )
        .scalars()
        .all()
    ):
        utterance_counts[u] = utterance_counts.get(u, 0) + 1

    people = (
        db.execute(select(Person).where(Person.org_id == session.org_id))
        .scalars()
        .all()
    )
    people_by_id = {p.id: p for p in people}

    speaker_rows = [
        SessionSpeakerOut(
            id=ss.id,
            cluster_id=ss.cluster_id,
            person_id=ss.person_id,
            display_name=people_by_id[ss.person_id].display_name if ss.person_id and ss.person_id in people_by_id else None,
            resolution_method=ss.resolution_method.value,
            confidence=ss.confidence,
            utterance_count=utterance_counts.get(ss.cluster_id, 0),
        )
        for ss in session_speakers
    ]
    people_rows = [
        PersonOptionOut(id=p.id, display_name=p.display_name, email=p.email)
        for p in sorted(people, key=lambda person: person.display_name.lower())
    ]
    return MeetingSpeakersOut(people=people_rows, speakers=speaker_rows)


@router.post(
    "/{capture_session_id}/speakers/{session_speaker_id}",
    response_model=SpeakerCorrectionResponse,
)
async def correct_speaker(
    capture_session_id: str,
    session_speaker_id: str,
    body: SpeakerCorrectionIn,
    db: Session = Depends(get_db),
    _: None = Depends(require_session_member),
) -> SpeakerCorrectionResponse:
    session = _session_or_404(db, capture_session_id)
    speaker = db.get(SessionSpeaker, session_speaker_id)
    if speaker is None or speaker.capture_session_id != capture_session_id:
        raise HTTPException(404, "session speaker not found")

    person: Person | None = None
    if body.person_id is not None:
        person = db.get(Person, body.person_id)
        if person is None or person.org_id != session.org_id:
            raise HTTPException(404, "person not found in org")

    speaker.person_id = person.id if person else None
    speaker.resolution_method = SpeakerResolution.MANUAL
    speaker.confidence = 1.0 if person else 0.0
    db.flush()

    # Re-attribute all utterances in this cluster.
    utterances = (
        db.execute(
            select(Utterance).where(
                Utterance.capture_session_id == capture_session_id,
                Utterance.speaker_cluster_id == speaker.cluster_id,
            )
        )
        .scalars()
        .all()
    )
    for u in utterances:
        u.person_id = person.id if person else None
        u.attribution_confidence = 1.0 if person else 0.0
    db.flush()

    # Re-derive owner for any SPEAKER-source commitment whose utterance is
    # in this cluster (the correction is the new ground truth, so speaker-
    # derived owners must follow it; name-matched owners stay put).
    updated_item_ids: list[str] = []
    if utterances:
        utterance_ids = {u.id for u in utterances}
        speaker_items = (
            db.execute(
                select(KnowledgeItem).where(
                    KnowledgeItem.org_id == session.org_id,
                    KnowledgeItem.type == KnowledgeType.COMMITMENT,
                    KnowledgeItem.owner_source == "SPEAKER",
                    KnowledgeItem.owner_utterance_id.in_(utterance_ids),
                )
            )
            .scalars()
            .all()
        )
        for item in speaker_items:
            new_person_id = person.id if person else None
            new_confidence = 1.0 if person else 0.0
            if new_confidence >= MIN_OWNER_CONFIDENCE:
                item.owner_person_id = new_person_id
                item.owner_attribution_confidence = new_confidence
            else:
                item.owner_candidate_person_id = new_person_id
                item.owner_person_id = None
                item.owner_attribution_confidence = new_confidence
            updated_item_ids.append(item.id)
        db.flush()

    # Recompute the person's voiceprint from all MANUAL+ROSTER sessions.
    if person is not None:
        from app.speakers.identity import recompute_voiceprint
        recompute_voiceprint(db, person.id)

    db.commit()

    return SpeakerCorrectionResponse(
        session_speaker_id=speaker.id,
        person_id=person.id if person else None,
        display_name=person.display_name if person else None,
        utterance_ids=[u.id for u in utterances],
        updated_owner_item_ids=updated_item_ids,
    )
