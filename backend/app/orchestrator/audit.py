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
    orchestrator helper in this codebase (scheduler.py, retention.py)."""
    entry = AuditLog(org_id=org_id, actor=actor, event=event, detail=detail or {})
    db.add(entry)
    return entry
