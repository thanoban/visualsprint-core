"""Coverage-gap detection from raw cascade output (CLAUDE.md rule 6).

The cascade already signals failure via empty text (unrouted/failed span) or
a low but non-zero confidence -- this module turns that signal into a
first-class gap span instead of an unremarkable low-score Utterance row."""

from app.asr.coverage import CoverageGapStatus, detect_coverage_gaps
from app.interfaces.transcriber import Lang, TranscriptSegment


def _segment(text: str, confidence: float = 1.0, start: float = 0.0, end: float = 1.0) -> TranscriptSegment:
    return TranscriptSegment(
        start_s=start, end_s=end, text=text, lang_tags=[Lang.EN], asr_confidence=confidence, provider="fake"
    )


def test_empty_text_is_a_missing_gap():
    gaps = detect_coverage_gaps([_segment("", confidence=0.0, start=10.0, end=12.0)])
    assert len(gaps) == 1
    assert gaps[0].status == CoverageGapStatus.MISSING
    assert gaps[0].start_s == 10.0
    assert gaps[0].end_s == 12.0
    assert "fake" in gaps[0].reason


def test_low_confidence_nonempty_text_is_a_degraded_gap():
    gaps = detect_coverage_gaps([_segment("mumbled something", confidence=0.15)])
    assert len(gaps) == 1
    assert gaps[0].status == CoverageGapStatus.DEGRADED
    assert "0.15" in gaps[0].reason


def test_good_transcription_produces_no_gap():
    gaps = detect_coverage_gaps([_segment("API eka deploy panna ready", confidence=0.92)])
    assert gaps == []


def test_confidence_exactly_at_threshold_is_not_a_gap():
    from app.asr.coverage import DEGRADED_CONFIDENCE_THRESHOLD

    gaps = detect_coverage_gaps([_segment("borderline", confidence=DEGRADED_CONFIDENCE_THRESHOLD)])
    assert gaps == []


def test_mixed_batch_only_flags_the_bad_segments():
    segments = [
        _segment("good segment", confidence=0.9, start=0.0, end=1.0),
        _segment("", confidence=0.0, start=1.0, end=2.0),
        _segment("also good", confidence=0.8, start=2.0, end=3.0),
        _segment("shaky", confidence=0.2, start=3.0, end=4.0),
    ]
    gaps = detect_coverage_gaps(segments)
    assert [(g.start_s, g.status) for g in gaps] == [
        (1.0, CoverageGapStatus.MISSING),
        (3.0, CoverageGapStatus.DEGRADED),
    ]


def test_empty_input_produces_no_gaps():
    assert detect_coverage_gaps([]) == []
