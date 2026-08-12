"""Deterministic speaker identity fusion.

This module maps anonymous diarization clusters to org-scoped Person rows
without guessing. Roster labels win when their timing overlaps the diarized
cluster strongly enough; existing voiceprints can carry identity across
meetings; otherwise the cluster remains unresolved.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import (
    Person,
    PlatformSpeakerLabel,
    SessionSpeaker,
    SpeakerResolution,
    SpeakerTurn,
)

ROSTER_SESSION_MIN_LABEL_COVERAGE = 0.20
ROSTER_CLUSTER_MIN_DOMINANCE = 0.60
ROSTER_CLUSTER_MIN_MARGIN = 0.20
ROSTER_CLUSTER_MIN_LABEL_SECONDS = 5.0
VOICEPRINT_MIN_SIMILARITY = 0.82
VOICEPRINT_MIN_MARGIN = 0.05


@dataclass(frozen=True)
class IdentityResolution:
    session_speaker_id: str
    person_id: str | None
    method: SpeakerResolution
    confidence: float


def _overlap(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    a_norm = sum(x * x for x in a) ** 0.5
    b_norm = sum(y * y for y in b) ** 0.5
    if a_norm == 0 or b_norm == 0:
        return 0.0
    return dot / (a_norm * b_norm)


def _resolve_unique_person_by_name(db: Session, org_id: str, display_name: str) -> str | None:
    normalized = display_name.strip().lower()
    people = db.execute(select(Person).where(Person.org_id == org_id)).scalars().all()
    matches: list[str] = []
    for person in people:
        if person.display_name.strip().lower() == normalized:
            matches.append(person.id)
            continue
        if any(str(alias).strip().lower() == normalized for alias in person.aliases or []):
            matches.append(person.id)
    unique = set(matches)
    return next(iter(unique)) if len(unique) == 1 else None


def _roster_label_coverage(turns: list[SpeakerTurn], labels: list[PlatformSpeakerLabel]) -> float:
    total_turn_s = sum(max(0.0, t.end_s - t.start_s) for t in turns)
    if total_turn_s <= 0:
        return 0.0
    labelled_s = 0.0
    for turn in turns:
        labelled_s += min(
            max(0.0, turn.end_s - turn.start_s),
            sum(_overlap(turn.start_s, turn.end_s, label.start_s, label.end_s) for label in labels),
        )
    return labelled_s / total_turn_s


def _resolve_by_roster(
    db: Session,
    org_id: str,
    speaker: SessionSpeaker,
    turns: list[SpeakerTurn],
    labels: list[PlatformSpeakerLabel],
) -> IdentityResolution | None:
    cluster_turns = [
        t
        for t in turns
        if t.cluster_id == speaker.cluster_id and t.audio_track_id == speaker.audio_track_id
    ]
    cluster_s = sum(max(0.0, t.end_s - t.start_s) for t in cluster_turns)
    if cluster_s <= 0:
        return None

    seconds_by_name: dict[str, float] = {}
    for turn in cluster_turns:
        for label in labels:
            overlap = _overlap(turn.start_s, turn.end_s, label.start_s, label.end_s)
            if overlap > 0:
                seconds_by_name[label.display_name] = (
                    seconds_by_name.get(label.display_name, 0.0) + overlap
                )
    if not seconds_by_name:
        return None

    ranked = sorted(seconds_by_name.items(), key=lambda pair: pair[1], reverse=True)
    dominant_name, dominant_s = ranked[0]
    runner_up_s = ranked[1][1] if len(ranked) > 1 else 0.0
    dominance = dominant_s / cluster_s
    margin = (dominant_s - runner_up_s) / cluster_s
    if (
        dominance < ROSTER_CLUSTER_MIN_DOMINANCE
        or margin < ROSTER_CLUSTER_MIN_MARGIN
        or dominant_s < ROSTER_CLUSTER_MIN_LABEL_SECONDS
    ):
        return None

    person_id = _resolve_unique_person_by_name(db, org_id, dominant_name)
    if person_id is None:
        return None
    return IdentityResolution(
        session_speaker_id=speaker.id,
        person_id=person_id,
        method=SpeakerResolution.ROSTER,
        confidence=min(dominance, 1.0),
    )


def _voiceprint_resolutions(
    db: Session, org_id: str, speakers: list[SessionSpeaker]
) -> list[IdentityResolution]:
    people = (
        db.execute(
            select(Person).where(
                Person.org_id == org_id,
                Person.voiceprint.isnot(None),
                Person.voiceprint_reliable.is_(True),
            )
        )
        .scalars()
        .all()
    )
    scored: list[tuple[float, float, SessionSpeaker, Person]] = []
    for speaker in speakers:
        if not speaker.embedding:
            continue
        candidates = sorted(
            ((_cosine(speaker.embedding, person.voiceprint), person) for person in people),
            key=lambda pair: pair[0],
            reverse=True,
        )
        if not candidates:
            continue
        best_score, best_person = candidates[0]
        second_score = candidates[1][0] if len(candidates) > 1 else 0.0
        margin = best_score - second_score
        if best_score >= VOICEPRINT_MIN_SIMILARITY and margin >= VOICEPRINT_MIN_MARGIN:
            scored.append((best_score, margin, speaker, best_person))

    assigned_people: set[str] = set()
    assigned_speakers: set[str] = set()
    resolutions: list[IdentityResolution] = []
    for score, _margin, speaker, person in sorted(scored, key=lambda row: row[0], reverse=True):
        if person.id in assigned_people or speaker.id in assigned_speakers:
            continue
        assigned_people.add(person.id)
        assigned_speakers.add(speaker.id)
        resolutions.append(
            IdentityResolution(
                session_speaker_id=speaker.id,
                person_id=person.id,
                method=SpeakerResolution.VOICEPRINT,
                confidence=score,
            )
        )
    return resolutions


def resolve_session_speakers(db: Session, capture_session_id: str) -> list[IdentityResolution]:
    speakers = (
        db.execute(
            select(SessionSpeaker).where(SessionSpeaker.capture_session_id == capture_session_id)
        )
        .scalars()
        .all()
    )
    if not speakers:
        return []
    org_id = speakers[0].org_id
    turns = (
        db.execute(select(SpeakerTurn).where(SpeakerTurn.capture_session_id == capture_session_id))
        .scalars()
        .all()
    )
    labels = (
        db.execute(
            select(PlatformSpeakerLabel).where(
                PlatformSpeakerLabel.capture_session_id == capture_session_id
            )
        )
        .scalars()
        .all()
    )

    resolutions_by_speaker: dict[str, IdentityResolution] = {}
    if _roster_label_coverage(turns, labels) >= ROSTER_SESSION_MIN_LABEL_COVERAGE:
        for speaker in speakers:
            resolved = _resolve_by_roster(db, org_id, speaker, turns, labels)
            if resolved is not None:
                resolutions_by_speaker[speaker.id] = resolved

    unresolved = [s for s in speakers if s.id not in resolutions_by_speaker]
    for resolved in _voiceprint_resolutions(db, org_id, unresolved):
        resolutions_by_speaker[resolved.session_speaker_id] = resolved

    changed: list[IdentityResolution] = []
    for speaker in speakers:
        resolved = resolutions_by_speaker.get(speaker.id)
        if resolved is None:
            speaker.person_id = None
            speaker.resolution_method = SpeakerResolution.UNRESOLVED
            speaker.confidence = 0.0
            continue
        speaker.person_id = resolved.person_id
        speaker.resolution_method = resolved.method
        speaker.confidence = resolved.confidence
        changed.append(resolved)
    db.flush()
    return changed


def recompute_voiceprint(db: Session, person_id: str) -> None:
    person = db.get(Person, person_id)
    if person is None:
        return
    speakers = (
        db.execute(
            select(SessionSpeaker).where(
                SessionSpeaker.person_id == person_id,
                SessionSpeaker.embedding.isnot(None),
                SessionSpeaker.resolution_method.in_(
                    [SpeakerResolution.ROSTER, SpeakerResolution.MANUAL]
                ),
            )
        )
        .scalars()
        .all()
    )
    if not speakers:
        person.voiceprint = None
        person.voiceprint_sample_count = 0
        person.voiceprint_reliable = True
        return
    dim = len(speakers[0].embedding)
    centroid = [0.0] * dim
    for speaker in speakers:
        for i, value in enumerate(speaker.embedding):
            centroid[i] += value
    centroid = [value / len(speakers) for value in centroid]
    person.voiceprint = centroid
    person.voiceprint_sample_count = len(speakers)
    similarities = [_cosine(centroid, speaker.embedding) for speaker in speakers]
    person.voiceprint_reliable = min(similarities) >= 0.70 if similarities else True
    db.flush()
