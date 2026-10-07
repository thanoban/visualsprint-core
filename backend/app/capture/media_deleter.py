"""Hard-deadline temporary media deletion worker.

Audio recording is disabled until this lifecycle is verified end-to-end.
No artifact may survive past its delete_after timestamp regardless of failure mode.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import CaptureMediaRef, CaptureRequest, MediaDeletionState
from app.interfaces.secretstore import SecretStore

# Maximum attempts before the ref is marked FAILED (not abandoned — still overdue-flagged).
_MAX_ATTEMPTS = 5
# Hard ceiling: no media artifact may outlive capture start + this offset.
MAX_RETENTION_SECONDS = 86_400  # 24 hours


def register_media_ref(
    db: Session,
    *,
    org_id: str,
    request_id: str,
    kind: str,
    store_ref: str,
    capture_started_at: datetime,
) -> CaptureMediaRef:
    """Create a deletion record. delete_after is capped at 24 h from capture start."""
    delete_after = capture_started_at + timedelta(seconds=MAX_RETENTION_SECONDS)
    ref = CaptureMediaRef(
        org_id=org_id,
        request_id=request_id,
        kind=kind,
        store_ref=store_ref,
        delete_after=delete_after,
    )
    db.add(ref)
    return ref


async def delete_pending(
    session_factory: Callable[[], Session],
    *,
    secret_store: SecretStore,
    now: datetime | None = None,
    batch_size: int = 50,
) -> dict[str, int]:
    """Delete pending media refs whose delete_after has passed or are overdue.

    Returns counts: {"deleted": N, "failed": N, "overdue_flagged": N}.
    """
    timestamp = now or datetime.now(UTC)
    counts = {"deleted": 0, "failed": 0, "overdue_flagged": 0}

    with session_factory() as db:
        refs = list(
            db.scalars(
                select(CaptureMediaRef)
                .where(
                    CaptureMediaRef.state == MediaDeletionState.PENDING,
                    CaptureMediaRef.delete_after <= timestamp,
                )
                .order_by(CaptureMediaRef.delete_after)
                .limit(batch_size)
            )
        )

    for ref_id in [r.id for r in refs]:
        with session_factory() as db:
            ref = db.get(CaptureMediaRef, ref_id)
            if ref is None or ref.state != MediaDeletionState.PENDING:
                continue
            ref.delete_attempts += 1
            delete_after = ref.delete_after
            if delete_after.tzinfo is None:
                delete_after = delete_after.replace(tzinfo=UTC)
            if timestamp > delete_after:
                ref.overdue = True
                counts["overdue_flagged"] += 1
            try:
                await secret_store.delete(ref.store_ref)
                ref.state = MediaDeletionState.DELETED
                ref.deleted_at = timestamp
                counts["deleted"] += 1
            except Exception:
                if ref.delete_attempts >= _MAX_ATTEMPTS:
                    ref.state = MediaDeletionState.FAILED
                    counts["failed"] += 1
                # else: stays PENDING for the next run
            db.commit()

    return counts


def list_overdue(
    db: Session,
    *,
    org_id: str | None = None,
    now: datetime | None = None,
) -> list[CaptureMediaRef]:
    """Return refs whose delete_after has passed and are not yet deleted."""
    timestamp = now or datetime.now(UTC)
    q = select(CaptureMediaRef).where(
        CaptureMediaRef.state == MediaDeletionState.PENDING,
        CaptureMediaRef.delete_after < timestamp,
    )
    if org_id is not None:
        q = q.where(CaptureMediaRef.org_id == org_id)
    return list(db.scalars(q))


def capture_started_at_for_request(db: Session, request_id: str) -> datetime | None:
    """Return the CaptureRequest.created_at as the capture-start anchor for deletion."""
    req = db.get(CaptureRequest, request_id)
    if req is None:
        return None
    ts = req.created_at
    if ts is not None and ts.tzinfo is None:
        ts = ts.replace(tzinfo=UTC)
    return ts
