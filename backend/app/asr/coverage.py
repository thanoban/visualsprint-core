"""Turns ASR cascade output into coverage gaps — CLAUDE.md rule 6: "Capture
gaps are data, not silence. Any coverage hole becomes a coverage_interval
row." The cascade (app/asr/cascade.py) already produces the exact signal
this needs (empty text on an unrouted/failed span, or a low-confidence
result) — this module is what turns that signal into a first-class,
reportable gap instead of silently becoming an unremarkable low-score
Utterance row indistinguishable from "the speaker just mumbled."
"""

from enum import StrEnum

from pydantic import BaseModel

from app.interfaces.transcriber import TranscriptSegment

# A non-empty transcript below this confidence was produced, but is unreliable.
DEGRADED_CONFIDENCE_THRESHOLD = 0.3


class CoverageGapStatus(StrEnum):
    DEGRADED = "degraded"
    MISSING = "missing"


class CoverageGapSpan(BaseModel):
    start_s: float
    end_s: float
    status: CoverageGapStatus
    reason: str


def detect_coverage_gaps(segments: list[TranscriptSegment]) -> list[CoverageGapSpan]:
    """Pure function, no DB — testable without a session. Caller
    (app/orchestrator/worker.py) converts these into `CoverageInterval` rows."""
    gaps: list[CoverageGapSpan] = []
    for seg in segments:
        if not seg.text.strip():
            gaps.append(
                CoverageGapSpan(
                    start_s=seg.start_s,
                    end_s=seg.end_s,
                    status=CoverageGapStatus.MISSING,
                    reason=f"no provider could transcribe this span (provider={seg.provider})",
                )
            )
        elif seg.asr_confidence < DEGRADED_CONFIDENCE_THRESHOLD:
            gaps.append(
                CoverageGapSpan(
                    start_s=seg.start_s,
                    end_s=seg.end_s,
                    status=CoverageGapStatus.DEGRADED,
                    reason=(
                        f"low-confidence transcription ({seg.asr_confidence:.2f}, "
                        f"provider={seg.provider})"
                    ),
                )
            )
    return gaps
