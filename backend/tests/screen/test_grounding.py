from dataclasses import dataclass, field

import pytest

from app.screen.grounding import GroundingMethod, ground_utterances, score_grounding


@dataclass
class FakeUtterance:
    id: str
    start_s: float
    end_s: float
    text: str


@dataclass
class FakeKeyframe:
    id: str
    valid_from_s: float
    valid_to_s: float
    ocr_text: str = ""
    detected_entities: list = field(default_factory=list)


def test_temporal_overlap_scores_above_zero():
    utterance = FakeUtterance(id="u1", start_s=10.0, end_s=12.0, text="let's move on")
    keyframe = FakeKeyframe(id="k1", valid_from_s=8.0, valid_to_s=20.0, ocr_text="dashboard")

    result = score_grounding(utterance, keyframe)

    assert result.method == GroundingMethod.TEMPORAL
    assert 0.0 < result.score <= 1.0
    assert result.utterance_id == "u1"
    assert result.keyframe_id == "k1"


def test_no_overlap_scores_zero_without_lexical_match():
    utterance = FakeUtterance(id="u1", start_s=0.0, end_s=2.0, text="hello everyone")
    keyframe = FakeKeyframe(
        id="k1", valid_from_s=100.0, valid_to_s=110.0, ocr_text="nothing relevant"
    )

    result = score_grounding(utterance, keyframe)

    assert result.score == 0.0


def test_lexical_match_boosts_overlapping_pair_to_both():
    utterance = FakeUtterance(id="u1", start_s=10.0, end_s=12.0, text="PAY-442 is blocking us")
    keyframe = FakeKeyframe(
        id="k1", valid_from_s=8.0, valid_to_s=20.0, ocr_text="Ticket PAY-442 status: open"
    )

    result = score_grounding(utterance, keyframe)

    assert result.method == GroundingMethod.BOTH
    temporal_only = score_grounding(
        FakeUtterance(id="u1", start_s=10.0, end_s=12.0, text="no ticket mentioned here"),
        keyframe,
    )
    assert result.score > temporal_only.score


def test_lexical_match_without_temporal_overlap_scores_lexical():
    utterance = FakeUtterance(id="u1", start_s=0.0, end_s=1.0, text="PAY-442 is blocking us")
    keyframe = FakeKeyframe(
        id="k1", valid_from_s=500.0, valid_to_s=510.0, ocr_text="Ticket PAY-442 status: open"
    )

    result = score_grounding(utterance, keyframe)

    assert result.method == GroundingMethod.LEXICAL
    assert result.score == pytest.approx(0.5)


def test_lexical_match_checks_detected_entities_too():
    utterance = FakeUtterance(id="u1", start_s=0.0, end_s=1.0, text="check JIRA-9 please")
    keyframe = FakeKeyframe(
        id="k1",
        valid_from_s=500.0,
        valid_to_s=510.0,
        ocr_text="",
        detected_entities=[{"text": "JIRA-9"}],
    )

    result = score_grounding(utterance, keyframe)

    assert result.score > 0.0


def test_ground_utterances_filters_by_threshold_and_covers_all_pairs():
    utterances = [
        FakeUtterance(id="u1", start_s=0.0, end_s=2.0, text="on screen now"),
        FakeUtterance(id="u2", start_s=100.0, end_s=101.0, text="unrelated later"),
    ]
    keyframes = [FakeKeyframe(id="k1", valid_from_s=0.0, valid_to_s=5.0, ocr_text="dashboard")]

    scores = ground_utterances(utterances, keyframes, threshold=0.3)

    assert len(scores) == 1
    assert scores[0].utterance_id == "u1"
    assert scores[0].keyframe_id == "k1"
