"""ActionConnector implementations — execute-only, human-gated.

Every connector in this package implements `app.interfaces.actions.ActionConnector`.
None of these modules import `app.db.models` or otherwise have access to a
`ProposedAction` row: `execute()` takes only an `ActionPayload` (plain data), so
there is no code path here that can check, set, or bypass approval status. The
caller (orchestrator integration) is solely responsible for guaranteeing an
approved `ProposedAction` exists before invoking a connector.
"""
