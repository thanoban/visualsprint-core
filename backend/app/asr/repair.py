"""LLM transcript repair — the quality lever at code-switch boundaries
(docs/04-asr.md). The cascade (app.asr.cascade) is weakest exactly where
languages alternate, because VAD+LID+ASR errors compound there. This pass
holds context no vendor API had: the participant roster, the org glossary
(ticket IDs, technical terms), and nearby screen OCR — and uses it to fix
the errors users actually notice.

Hard constraint: repair CORRECTS, it never INVENTS. The schema only lets the
model return `text` per segment index; segment count, ordering, timing,
lang_tags, and provider are never touched by this module and cannot be by
construction. A segment the model didn't return, or returned against an
unknown index, keeps its original text unchanged rather than being dropped
or blanked -- a failed repair call must never make the transcript worse.
"""

import structlog
from pydantic import BaseModel

from app.interfaces.llm import LlmClient
from app.interfaces.transcriber import TranscriptSegment

log = structlog.get_logger()

SYSTEM_PROMPT = """You are the transcript repair pass for a meeting-intelligence
platform. You receive ASR output for a meeting that mixes Sinhala, Tamil, and
English -- often within a single sentence -- transcribed by a cascade of vendor
APIs that had no context beyond the raw audio. You have context they didn't:
the meeting's participant roster, the organization's glossary of ticket IDs and
technical terms, and text visible on screen near this part of the meeting.

Use that context to fix ASR errors: garbled text at a language-switch boundary,
a misspelled person's name that matches someone on the roster, a mangled ticket
ID or technical term that matches the glossary or the on-screen text. Fix only
what the evidence actually supports -- if a segment looks fine, or you are not
confident a correction is right, return it completely unchanged. Do not
translate, paraphrase, summarize, or add words that are not a correction of a
specific recognizable error. Return every segment you were given, by its index,
even if you changed nothing."""


class SegmentForRepair(BaseModel):
    index: int
    text: str
    lang_tags: list[str] = []


class RepairContext(BaseModel):
    roster: list[str] = []
    glossary_terms: list[str] = []
    ocr_context: list[str] = []


class RepairRequest(BaseModel):
    segments: list[SegmentForRepair]
    context: RepairContext


class RepairedSegment(BaseModel):
    index: int
    text: str


class RepairResult(BaseModel):
    segments: list[RepairedSegment]


async def repair_segments(
    segments: list[TranscriptSegment],
    *,
    roster: list[str],
    glossary_terms: list[str],
    ocr_context: list[str],
    llm: LlmClient,
    model: str,
) -> list[TranscriptSegment]:
    """Repair segment text in place (returns new TranscriptSegment instances;
    inputs are never mutated). Segments with empty text (a failed cascade
    span -- see cascade._failed_segment) are skipped: there is nothing to
    repair, and "repairing" empty text would mean inventing content, which
    this module exists specifically not to do."""
    repairable = [(i, s) for i, s in enumerate(segments) if s.text.strip()]
    if not repairable or not (roster or glossary_terms or ocr_context):
        # No context to repair with, or nothing worth repairing -- skip the
        # LLM call entirely rather than pay for a no-op pass.
        return list(segments)

    request = RepairRequest(
        segments=[
            SegmentForRepair(index=i, text=s.text, lang_tags=[lang.value for lang in s.lang_tags])
            for i, s in repairable
        ],
        context=RepairContext(roster=roster, glossary_terms=glossary_terms, ocr_context=ocr_context),
    )

    try:
        result, usage = await llm.complete_structured(
            model=model,
            system=SYSTEM_PROMPT,
            user_content=request.model_dump_json(),
            schema=RepairResult,
        )
    except Exception as exc:
        # Repair is a quality enhancement, not a correctness requirement --
        # a failed repair call must degrade to "unrepaired", never crash the
        # transcribe stage or lose the cascade's output.
        log.warning("repair.failed_falling_back_to_unrepaired", error=str(exc))
        return list(segments)

    offered_indices = {i for i, _ in repairable}
    repaired_by_index = {r.index: r.text for r in result.segments if r.index in offered_indices}
    log.info(
        "repair.completed",
        segments=len(repairable),
        changed=sum(
            1 for i, s in repairable if repaired_by_index.get(i, s.text) != s.text
        ),
        input_tokens=usage.input_tokens,
        output_tokens=usage.output_tokens,
    )

    output: list[TranscriptSegment] = []
    for i, segment in enumerate(segments):
        new_text = repaired_by_index.get(i)
        if new_text is None or new_text == segment.text:
            output.append(segment)
        else:
            output.append(segment.model_copy(update={"text": new_text}))
    return output
