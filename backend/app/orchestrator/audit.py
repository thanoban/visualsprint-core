"""Audit log -- app.db.models.AuditLog existed in the schema with nothing
ever writing to it. Deliberately small and generic (actor/event/detail),
not a framework: call sites decide what's worth recording. Scoped to the
two highest-value integration points for now -- action approve/reject
(the literal enforcement boundary CLAUDE.md rule 5 cares about) and
retention purges (exactly what a compliance reviewer asks for first:
"prove you deleted it, and when") -- not a sweeping instrumentation of
every mutation in the app.
"""

from sqlalchemy.orm import Session

from app.db.models import AuditLog


def log_audit_event(
    db: Session, *, org_id: str, actor: str, event: str, detail: dict | None = None
) -> AuditLog:
    """Adds the row to the session but does not commit -- call sites own
    their own transaction boundary, same convention as every other
    orchestrator helper in this codebase (scheduler.py, retention.py).

    `detail` should carry IDs and structural facts (kind, status, counts),
    never meeting-content-derived free text (titles, statements, transcript
    fragments) -- AuditLog has no FK back to whatever it's describing, so
    nothing can ever find and scrub it later. A retention purge or an
    on-demand erasure can delete the source row completely and the copy
    sitting here would outlive it, silently defeating the deletion. Found
    the hard way: action_approved/action_rejected/meeting_erasure_requested
    all used to store a `title` pulled straight from meeting/knowledge-item
    content."""
    entry = AuditLog(org_id=org_id, actor=actor, event=event, detail=detail or {})
    db.add(entry)
    return entry
