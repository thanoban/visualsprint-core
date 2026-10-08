"""Short transactional outbox leases. Only the current fence can publish."""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.db.models import OutboxEvent, OutboxStatus


@dataclass(frozen=True)
class Claim:
    id: str
    entity_id: str
    org_id: str
    payload: dict[str, str]
    fence: int
    attempt: int
    worker_id: str


def claim_next(
    sessions: Callable[[], Session], operation: str, worker_id: str, *, now: datetime | None = None
) -> Claim | None:
    timestamp = now or datetime.now(UTC)
    with sessions() as db:
        event = db.scalar(
            select(OutboxEvent)
            .where(
                OutboxEvent.operation == operation,
                OutboxEvent.run_at <= timestamp,
                or_(
                    OutboxEvent.status == OutboxStatus.PENDING,
                    (OutboxEvent.status == OutboxStatus.RUNNING)
                    & (OutboxEvent.locked_at < timestamp - timedelta(minutes=3)),
                ),
            )
            .order_by(OutboxEvent.run_at, OutboxEvent.id)
            .with_for_update(skip_locked=True)
            .limit(1)
        )
        if event is None:
            return None
        event.status = OutboxStatus.RUNNING
        event.locked_by, event.locked_at = worker_id, timestamp
        event.fencing_version += 1
        event.attempts += 1
        result = Claim(
            event.id,
            event.entity_id,
            event.org_id,
            {k: v for k, v in event.payload.items() if isinstance(v, str)},
            event.fencing_version,
            event.attempts,
            worker_id,
        )
        db.commit()
        return result


def owned_event(db: Session, claim: Claim) -> OutboxEvent | None:
    return db.scalar(
        select(OutboxEvent)
        .where(
            OutboxEvent.id == claim.id,
            OutboxEvent.status == OutboxStatus.RUNNING,
            OutboxEvent.fencing_version == claim.fence,
            OutboxEvent.locked_by == claim.worker_id,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )


def finish(event: OutboxEvent, error: str | None = None, *, retry: bool = False) -> None:
    event.error_code = error
    event.status = (
        OutboxStatus.PENDING if retry else (OutboxStatus.FAILED if error else OutboxStatus.DONE)
    )
    event.locked_at, event.locked_by = None, None
    if retry:
        event.run_at = datetime.now(UTC) + timedelta(seconds=min(300, 10 * 2**event.attempts))
