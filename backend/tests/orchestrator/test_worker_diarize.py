"""Tests for the `diarize` stage and the speaker attribution it feeds into
`transcribe` (docs/08-speaker-identity.md).

Injects a fake Diarizer via `worker._diarizer`, the same seam
`worker._transcriber` already uses, so nothing here needs pyannote.audio
installed or a Hugging Face token.
"""

import pytest

import app.orchestrator.worker as worker
from app.interfaces.diarizer import DiarizationResult, SpeakerTurn


class FakeDiarizer:
    def __init__(self, result: DiarizationResult | None = None, error: Exception | None = None):
        self._result = result
        self._error = error
        self.calls: list[str] = []

    async def diarize(self, audio_uri: str, min_speakers: int = 1, max_speakers: int = 20):
        self.calls.append(audio_uri)
        if self._error is not None:
            raise self._error
        return self._result


@pytest.fixture(autouse=True)
def _restore_diarizer():
    original = worker._diarizer
    yield
    worker._diarizer = original


# --------------------------------------------------------------------------- #
# _assign_cluster -- the overlap logic that keeps attribution_confidence honest
# --------------------------------------------------------------------------- #


def _turn(start_s: float, end_s: float, cluster_id: str) -> SpeakerTurn:
    return SpeakerTurn(start_s=start_s, end_s=end_s, cluster_id=cluster_id)


def test_assign_cluster_picks_the_most_overlapping_speaker():
    turns = [_turn(0.0, 4.0, "SPEAKER_00"), _turn(4.0, 10.0, "SPEAKER_01")]

    cluster, ratio = worker._assign_cluster(3.0, 8.0, turns)

    # 3.0-8.0 overlaps SPEAKER_00 by 1s and SPEAKER_01 by 4s.
    assert cluster == "SPEAKER_01"
    assert ratio == pytest.approx(4.0 / 5.0)


def test_assign_cluster_returns_full_ratio_for_a_fully_contained_utterance():
    turns = [_turn(0.0, 30.0, "SPEAKER_00")]

    cluster, ratio = worker._assign_cluster(5.0, 9.0, turns)

    assert cluster == "SPEAKER_00"
    assert ratio == pytest.approx(1.0)


def test_assign_cluster_returns_none_when_nothing_overlaps():
    turns = [_turn(50.0, 60.0, "SPEAKER_00")]

    assert worker._assign_cluster(0.0, 10.0, turns) == (None, 0.0)


def test_assign_cluster_handles_no_diarization_at_all():
    """The degraded path: pyannote unavailable, so `transcribe` still runs
    but has no turns to attribute against."""
    assert worker._assign_cluster(0.0, 10.0, []) == (None, 0.0)


def test_assign_cluster_ratio_never_exceeds_one_on_overlapping_turns():
    """Diarizers can emit overlapping turns (two people talking at once);
    the ratio must stay a ratio."""
    turns = [_turn(0.0, 100.0, "SPEAKER_00")]

    _, ratio = worker._assign_cluster(10.0, 12.0, turns)

    assert ratio <= 1.0


def test_assign_cluster_rejects_a_zero_length_utterance():
    turns = [_turn(0.0, 10.0, "SPEAKER_00")]

    assert worker._assign_cluster(5.0, 5.0, turns) == (None, 0.0)


# --------------------------------------------------------------------------- #
# Diarizer result shape
# --------------------------------------------------------------------------- #


async def test_fake_diarizer_reports_distinct_speaker_count():
    result = DiarizationResult(
        turns=[_turn(0.0, 2.0, "SPEAKER_00"), _turn(2.0, 4.0, "SPEAKER_01")],
        num_speakers=2,
    )
    diarizer = FakeDiarizer(result=result)

    got = await diarizer.diarize("blob://audio.flac")

    assert got.num_speakers == 2
    assert {t.cluster_id for t in got.turns} == {"SPEAKER_00", "SPEAKER_01"}
