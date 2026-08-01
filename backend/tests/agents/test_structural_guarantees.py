"""CLAUDE.md rules 2 and 3 are the whole trust model of this product -- test
them as schema facts, not as behavior someone could quietly regress.
"""

from app.agents.report import KeyframeRef, ReportEvidence, ReportInput, ReportKnowledgeItem, UtteranceRef
from app.agents.verification import CandidateForVerification


def test_verification_input_has_no_rationale_field():
    """Rule 3: verification must never see Context's reasoning."""
    field_names = set(CandidateForVerification.model_fields.keys())
    assert "rationale" not in field_names, (
        "CandidateForVerification grew a rationale field -- this is exactly "
        "the leak rule 3 forbids. Verification must see only the claim + evidence."
    )


def _all_str_field_names(*models) -> set[str]:
    names: set[str] = set()
    for model in models:
        names.update(model.model_fields.keys())
    return names


def test_report_input_chain_has_no_transcript_capable_field():
    """Rule 2: Report Intelligence's input schema cannot contain raw
    transcript text. Checked across every model ReportInput can reach --
    UtteranceRef in particular must carry only id/timing/speaker, never text."""
    reachable = _all_str_field_names(ReportInput, ReportKnowledgeItem, ReportEvidence, UtteranceRef, KeyframeRef)
    forbidden = {"text", "content", "transcript", "utterance_text"}
    leaked = reachable & forbidden
    assert not leaked, f"ReportInput's schema chain gained a field that could hold transcript text: {leaked}"

    utterance_fields = set(UtteranceRef.model_fields.keys())
    assert utterance_fields == {"utterance_id", "start_s", "end_s", "speaker_person_id"}, (
        "UtteranceRef's field set changed -- re-verify none of the new fields can hold "
        f"transcript text. Current fields: {utterance_fields}"
    )
