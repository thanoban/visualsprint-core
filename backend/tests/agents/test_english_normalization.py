"""Report statements must read in English regardless of the meeting's spoken
language mix -- decided at Context Intelligence (full context available for
accurate translation) not as a later isolated pass. This can't be verified
against a real LLM call without live credentials, so this is a regression
guard on the instruction itself: if someone edits the prompt and drops the
requirement, this test catches it immediately instead of silently shipping
a bilingual report the next time someone actually runs the pipeline.
"""

from app.agents.context import SYSTEM_PROMPT as CONTEXT_PROMPT
from app.agents.report import SYSTEM_PROMPT as REPORT_PROMPT


def test_context_intelligence_instructed_to_write_statements_in_english():
    assert "English" in CONTEXT_PROMPT
    assert "statement" in CONTEXT_PROMPT.lower()


def test_context_intelligence_instructed_not_to_translate_evidence():
    assert "not" in CONTEXT_PROMPT.lower() and "translate" in CONTEXT_PROMPT.lower()


def test_report_intelligence_instructed_to_stay_in_english():
    assert "English" in REPORT_PROMPT
