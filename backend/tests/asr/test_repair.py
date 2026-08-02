"""LLM transcript repair: corrects, never invents. Every failure mode here
must degrade to the cascade's original output, never to worse or missing
text -- repair is a quality enhancement, not a correctness dependency."""

from app.asr.repair import RepairedSegment, RepairResult, repair_segments
from app.interfaces.transcriber import Lang, TranscriptSegment

from ..agents.conftest import FakeLlmClient


def _segment(text: str, lang: Lang = Lang.SI, start: float = 0.0, end: float = 1.0) -> TranscriptSegment:
    return TranscriptSegment(start_s=start, end_s=end, text=text, lang_tags=[lang], provider="fake")


async def test_no_context_skips_the_llm_call_entirely():
    """No roster/glossary/OCR -- nothing to repair with, so don't pay for a
    no-op call (and, critically, don't require a live LlmClient at all)."""
    segments = [_segment("mage nama Kasun")]
    llm = FakeLlmClient(RepairResult(segments=[]))

    result = await repair_segments(
        segments, roster=[], glossary_terms=[], ocr_context=[], llm=llm, model="x"
    )

    assert llm.calls == []
    assert result == segments


async def test_repairs_a_garbled_segment_using_roster_context():
    segments = [_segment("garbled name here")]
    llm = FakeLlmClient(RepairResult(segments=[RepairedSegment(index=0, text="Udula said this")]))

    result = await repair_segments(
        segments, roster=["Udula Silva"], glossary_terms=[], ocr_context=[], llm=llm, model="x"
    )

    assert result[0].text == "Udula said this"
    assert result[0].start_s == segments[0].start_s  # timing untouched
    assert result[0].lang_tags == segments[0].lang_tags  # lang_tags untouched


async def test_unchanged_segment_is_returned_as_is_not_a_copy():
    """A segment the model didn't flag as changed should be structurally
    identical output -- this is what lets the caller detect `repaired`."""
    segments = [_segment("this was already fine")]
    llm = FakeLlmClient(
        RepairResult(segments=[RepairedSegment(index=0, text="this was already fine")])
    )

    result = await repair_segments(
        segments, roster=["Someone"], glossary_terms=[], ocr_context=[], llm=llm, model="x"
    )

    assert result[0].text == segments[0].text


async def test_missing_index_in_response_falls_back_to_original_unchanged():
    """The model dropped a segment from its response -- never silently lose
    or blank that segment's text."""
    segments = [_segment("first segment"), _segment("second segment")]
    llm = FakeLlmClient(RepairResult(segments=[RepairedSegment(index=0, text="fixed first")]))

    result = await repair_segments(
        segments, roster=["Someone"], glossary_terms=[], ocr_context=[], llm=llm, model="x"
    )

    assert result[0].text == "fixed first"
    assert result[1].text == "second segment"  # untouched, not dropped


async def test_llm_failure_falls_back_to_unrepaired_transcript():
    segments = [_segment("original text")]

    class FailingLlm:
        async def complete_structured(self, **kwargs):
            raise RuntimeError("Vertex AI unavailable")

    result = await repair_segments(
        segments, roster=["Someone"], glossary_terms=[], ocr_context=[], llm=FailingLlm(), model="x"
    )

    assert result == segments


async def test_empty_text_segments_are_never_sent_to_the_llm():
    """A failed cascade span (cascade._failed_segment) has empty text --
    "repairing" it would mean inventing content from nothing."""
    segments = [_segment(""), _segment("real text")]
    llm = FakeLlmClient(RepairResult(segments=[RepairedSegment(index=1, text="fixed real text")]))

    result = await repair_segments(
        segments, roster=["Someone"], glossary_terms=[], ocr_context=[], llm=llm, model="x"
    )

    assert len(llm.calls) == 1
    sent_indices = [s["index"] for s in __import__("json").loads(llm.calls[0]["user_content"])["segments"]]
    assert sent_indices == [1]  # only the non-empty segment was offered up for repair
    assert result[0].text == ""  # empty segment untouched
    assert result[1].text == "fixed real text"


async def test_response_targeting_an_unoffered_index_is_ignored():
    """Defense in depth: even if the model hallucinates a repair for an
    index it was never given (e.g. an originally-empty segment), applying
    it must be structurally impossible -- not just unlikely."""
    segments = [_segment(""), _segment("real text")]
    llm = FakeLlmClient(
        RepairResult(segments=[RepairedSegment(index=0, text="invented content for the empty one")])
    )

    result = await repair_segments(
        segments, roster=["Someone"], glossary_terms=[], ocr_context=[], llm=llm, model="x"
    )

    assert result[0].text == ""  # never overwritten -- index 0 was never offered


async def test_repair_result_never_changes_segment_count():
    segments = [_segment("a"), _segment("b"), _segment("c")]
    llm = FakeLlmClient(
        RepairResult(segments=[RepairedSegment(index=0, text="a-fixed"), RepairedSegment(index=1, text="b-fixed")])
    )

    result = await repair_segments(
        segments, roster=["Someone"], glossary_terms=[], ocr_context=[], llm=llm, model="x"
    )

    assert len(result) == 3
