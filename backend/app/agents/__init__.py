"""The five agents: Context, Verification, Memory, Action, Report.

Each module exposes one async entrypoint taking (db: Session, capture_session_id: str,
llm: LlmClient | None = None). Agents interpret content only — they never call each
other or choose the next pipeline stage; the orchestrator (app.orchestrator) does that.
"""
