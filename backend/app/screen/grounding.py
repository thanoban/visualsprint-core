"""Speech↔screen grounding — score how likely an utterance was said "about"
a given keyframe, from temporal overlap boosted by lexical entity match.
Feeds `utterance_keyframe` rows (docs/05-data-model.md); this module only
scores pairs, it does not write to the DB.
"""

from __future__ import annotations

import enum
from typing import Protocol

from pydantic import BaseModel, Field

from app.screen.entities import extract_entities

TEMPORAL_WEIGHT = 0.6
LEXICAL_WEIGHT = 0.5
DEFAULT_THRESHOLD = 0.3
_EPS = 1e-6


class GroundingMethod(enum.StrEnum):
    TEMPORAL = "temporal"
    LEXICAL = "lexical"
    BOTH = "both"


class UtteranceLike(Protocol):
    id: str
    start_s: float
    end_s: float
    text: str


class KeyframeLike(Protocol):
    id: str
    valid_from_s: float
    valid_to_s: float
    ocr_text: str
    detected_entities: list


class GroundingScore(BaseModel):
    utterance_id: str
    keyframe_id: str
    score: float = Field(ge=0.0, le=1.0)
    method: GroundingMethod


def score_grounding(utterance: UtteranceLike, keyframe: KeyframeLike) -> GroundingScore:
    temporal_score = _temporal_score(utterance, keyframe)
    lexical_score = _lexical_score(utterance, keyframe)
    total = min(1.0, temporal_score + lexical_score)

    if temporal_score > 0 and lexical_score > 0:
        method = GroundingMethod.BOTH
    elif lexical_score > 0:
        method = GroundingMethod.LEXICAL
    else:
        method = GroundingMethod.TEMPORAL

    return GroundingScore(utterance_id=utterance.id, keyframe_id=keyframe.id, score=total, method=method)


def ground_utterances(
    utterances: list[UtteranceLike], keyframes: list[KeyframeLike], threshold: float = DEFAULT_THRESHOLD
) -> list[GroundingScore]:
    scores: list[GroundingScore] = []
    for utterance in utterances:
        for keyframe in keyframes:
            grounding = score_grounding(utterance, keyframe)
            if grounding.score >= threshold:
                scores.append(grounding)
    return scores


def _temporal_score(utterance: UtteranceLike, keyframe: KeyframeLike) -> float:
    overlap = _overlap_duration(
        utterance.start_s, utterance.end_s, keyframe.valid_from_s, keyframe.valid_to_s
    )
    if overlap <= 0:
        return 0.0
    utterance_duration = max(utterance.end_s - utterance.start_s, _EPS)
    overlap_ratio = min(1.0, overlap / utterance_duration)
    return overlap_ratio * TEMPORAL_WEIGHT


def _overlap_duration(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def _lexical_score(utterance: UtteranceLike, keyframe: KeyframeLike) -> float:
    utterance_entities = extract_entities(utterance.text)
    if not utterance_entities:
        return 0.0

    ocr_text = (keyframe.ocr_text or "").lower()
    keyframe_entity_texts = {_entity_text(e).lower() for e in (keyframe.detected_entities or [])}

    for entity in utterance_entities:
        needle = entity.text.lower()
        if needle in ocr_text or needle in keyframe_entity_texts:
            return LEXICAL_WEIGHT
    return 0.0


def _entity_text(entity: object) -> str:
    if isinstance(entity, str):
        return entity
    if isinstance(entity, dict):
        return str(entity.get("text", ""))
    return str(getattr(entity, "text", ""))
