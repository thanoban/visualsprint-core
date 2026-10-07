"""Leased dispatcher for durable capture outbox events.

The dispatcher commits an attempt before external I/O. If a process dies after
that commit, a later worker reconciles the attempt instead of blindly creating
a second bot.
"""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Protocol

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.db.models import (
    CaptureAttempt,
    CaptureAttemptState,
    CaptureRequest,
    CaptureRequestStatus,
    Org,
    OutboxEvent,
    OutboxStatus,
    ProviderBinding,
    ProviderBindingStatus,
)
from app.interfaces.capture_provider import (
    CaptureProvider,
    CaptureProviderError,
    CaptureStatus,
    MeetingTarget,
)
from app.interfaces.secretstore import SecretStore


class CaptureProviderResolver(Protocol):
    async def resolve(self, binding: ProviderBinding) -> CaptureProvider: ...


@dataclass(frozen=True)
class DispatchClaim:
    event_id: str
    request_id: str
    fencing_version: int


@dataclass(frozen=True)
class PreparedDispatch:
    claim: DispatchClaim
    attempt_id: str
    binding_id: str
    secret_ref: str
    platform: str
    native_meeting_id: str


_ACTIVE_STATES = {
    CaptureAttemptState.SCHEDULED,
    CaptureAttemptState.JOINING,
    CaptureAttemptState.WAITING_FOR_ADMISSION,
    CaptureAttemptState.BLOCKED,
    CaptureAttemptState.CAPTURING,
    CaptureAttemptState.STOPPING,
    CaptureAttemptState.UNKNOWN,
}

_STATE_MAP = {
    CaptureStatus.SCHEDULED: CaptureAttemptState.SCHEDULED,
    CaptureStatus.JOINING: CaptureAttemptState.JOINING,
    CaptureStatus.WAITING: CaptureAttemptState.WAITING_FOR_ADMISSION,
    CaptureStatus.BLOCKED: CaptureAttemptState.BLOCKED,
    CaptureStatus.CAPTURING: CaptureAttemptState.CAPTURING,
    CaptureStatus.STOPPING: CaptureAttemptState.STOPPING,
    CaptureStatus.ENDED: CaptureAttemptState.ENDED,
    CaptureStatus.FAILED: CaptureAttemptState.FAILED,
    CaptureStatus.UNKNOWN: CaptureAttemptState.UNKNOWN,
}


def _claim(
    session_factory: Callable[[], Session],
    *,
    worker_id: str,
    now: datetime,
    lease_seconds: int,
) -> DispatchClaim | None:
    with session_factory() as db:
        stale_before = now - timedelta(seconds=lease_seconds)
        event = db.execute(
            select(OutboxEvent)
            .where(
                OutboxEvent.operation == "capture.dispatch",
                OutboxEvent.run_at <= now,
                or_(
                    OutboxEvent.status == OutboxStatus.PENDING,
                    (OutboxEvent.status == OutboxStatus.RUNNING)
                    & (OutboxEvent.locked_at < stale_before),
                ),
            )
            .order_by(OutboxEvent.run_at, OutboxEvent.created_at)
            .with_for_update(skip_locked=True)
            .limit(1)
        ).scalar_one_or_none()
        if event is None:
            return None
        event.status = OutboxStatus.RUNNING
        event.attempts += 1
        event.locked_by = worker_id
        event.locked_at = now
        event.fencing_version += 1
        claim = DispatchClaim(event.id, event.entity_id, event.fencing_version)
        db.commit()
        return claim


def _owned_event(db: Session, claim: DispatchClaim, worker_id: str) -> OutboxEvent | None:
    return db.execute(
        select(OutboxEvent).where(
            OutboxEvent.id == claim.event_id,
            OutboxEvent.status == OutboxStatus.RUNNING,
            OutboxEvent.locked_by == worker_id,
            OutboxEvent.fencing_version == claim.fencing_version,
        )
    ).scalar_one_or_none()


def _enqueue_reconciliation(db: Session, request: CaptureRequest) -> None:
    existing = db.execute(
        select(OutboxEvent.id).where(
            OutboxEvent.operation == "capture.reconcile",
            OutboxEvent.entity_id == request.id,
            OutboxEvent.input_revision == request.input_hash,
        )
    ).scalar_one_or_none()
    if existing is None:
        db.add(
            OutboxEvent(
                org_id=request.org_id,
                operation="capture.reconcile",
                entity_id=request.id,
                input_revision=request.input_hash,
                payload={"capture_request_id": request.id},
            )
        )


def _prepare(
    session_factory: Callable[[], Session],
    claim: DispatchClaim,
    *,
    worker_id: str,
    now: datetime,
    max_concurrent: int,
) -> PreparedDispatch | None:
    with session_factory() as db:
        event = _owned_event(db, claim, worker_id)
        request = db.get(CaptureRequest, claim.request_id)
        if event is None or request is None:
            return None
        db.execute(select(Org.id).where(Org.id == request.org_id).with_for_update()).scalar_one()

        previous = db.execute(
            select(CaptureAttempt)
            .where(CaptureAttempt.request_id == request.id)
            .order_by(CaptureAttempt.attempt_no.desc())
            .limit(1)
        ).scalar_one_or_none()
        if previous is not None:
            request.status = CaptureRequestStatus.RECONCILIATION_REQUIRED
            previous.state = CaptureAttemptState.UNKNOWN
            previous.error_code = "dispatch_ownership_recovered"
            _enqueue_reconciliation(db, request)
            event.status = OutboxStatus.DONE
            event.locked_by = None
            event.locked_at = None
            db.commit()
            return None

        active = db.scalar(
            select(func.count())
            .select_from(CaptureAttempt)
            .where(
                CaptureAttempt.org_id == request.org_id,
                CaptureAttempt.state.in_(_ACTIVE_STATES),
            )
        )
        if int(active or 0) >= max_concurrent:
            event.status = OutboxStatus.PENDING
            event.run_at = now + timedelta(seconds=30)
            event.locked_by = None
            event.locked_at = None
            db.commit()
            return None

        bindings = db.execute(
            select(ProviderBinding).where(
                ProviderBinding.org_id == request.org_id,
                ProviderBinding.provider == "vexa",
                ProviderBinding.status == ProviderBindingStatus.ACTIVE,
            ).order_by(ProviderBinding.created_at, ProviderBinding.id).limit(2)
        ).scalars().all()
        if len(bindings) != 1:
            request.status = CaptureRequestStatus.FAILED
            event.status = OutboxStatus.FAILED
            event.error_code = (
                "capture_provider_not_configured"
                if not bindings
                else "capture_provider_binding_ambiguous"
            )
            event.locked_by = None
            event.locked_at = None
            db.commit()
            return None
        binding = bindings[0]

        attempt = CaptureAttempt(
            org_id=request.org_id,
            request_id=request.id,
            attempt_no=1,
            provider_binding_id=binding.id,
            state=CaptureAttemptState.SCHEDULED,
            fencing_version=claim.fencing_version,
        )
        request.status = CaptureRequestStatus.DISPATCHING
        db.add(attempt)
        db.commit()
        return PreparedDispatch(
            claim=claim,
            attempt_id=attempt.id,
            binding_id=binding.id,
            secret_ref=request.meeting_url_secret_ref,
            platform=request.platform,
            native_meeting_id=request.native_meeting_id,
        )


def _finish_failure(
    session_factory: Callable[[], Session],
    prepared: PreparedDispatch,
    *,
    worker_id: str,
    code: str,
    uncertain: bool,
) -> None:
    with session_factory() as db:
        event = _owned_event(db, prepared.claim, worker_id)
        attempt = db.get(CaptureAttempt, prepared.attempt_id)
        request = db.get(CaptureRequest, prepared.claim.request_id)
        if event is None or attempt is None or request is None:
            return
        attempt.error_code = code
        event.error_code = code
        event.status = OutboxStatus.DONE if uncertain else OutboxStatus.FAILED
        if uncertain:
            attempt.state = CaptureAttemptState.UNKNOWN
            request.status = CaptureRequestStatus.DISPATCH_UNKNOWN
            _enqueue_reconciliation(db, request)
        else:
            attempt.state = CaptureAttemptState.FAILED
            request.status = CaptureRequestStatus.FAILED
        event.locked_by = None
        event.locked_at = None
        db.commit()


async def dispatch_next(
    session_factory: Callable[[], Session],
    *,
    secret_store: SecretStore,
    provider_resolver: CaptureProviderResolver,
    worker_id: str,
    now: datetime | None = None,
    lease_seconds: int = 60,
    max_concurrent: int = 5,
) -> bool:
    """Process at most one due dispatch event; return whether one was claimed."""

    timestamp = now or datetime.now(UTC)
    claim = _claim(
        session_factory, worker_id=worker_id, now=timestamp, lease_seconds=lease_seconds
    )
    if claim is None:
        return False
    prepared = _prepare(
        session_factory,
        claim,
        worker_id=worker_id,
        now=timestamp,
        max_concurrent=max_concurrent,
    )
    if prepared is None:
        return True

    try:
        meeting_url = await secret_store.get(prepared.secret_ref)
        target = MeetingTarget.from_url(meeting_url)
        if (
            target.platform != prepared.platform
            or target.native_meeting_id != prepared.native_meeting_id
        ):
            raise ValueError("meeting_secret_identity_mismatch")
        with session_factory() as db:
            binding = db.get(ProviderBinding, prepared.binding_id)
            if binding is None:
                raise KeyError("provider_binding_missing")
            provider = await provider_resolver.resolve(binding)
        snapshot = await provider.start(target)
    except CaptureProviderError as exc:
        _finish_failure(
            session_factory,
            prepared,
            worker_id=worker_id,
            code=exc.code,
            uncertain=exc.uncertain,
        )
        return True
    except (KeyError, ValueError):
        _finish_failure(
            session_factory,
            prepared,
            worker_id=worker_id,
            code="capture_dispatch_configuration_error",
            uncertain=False,
        )
        return True
    except Exception:
        # The provider may have accepted the request before an unexpected
        # client/parser failure. Reconcile; never automatically POST again.
        _finish_failure(
            session_factory,
            prepared,
            worker_id=worker_id,
            code="capture_dispatch_unresolved",
            uncertain=True,
        )
        return True

    with session_factory() as db:
        event = _owned_event(db, prepared.claim, worker_id)
        attempt = db.get(CaptureAttempt, prepared.attempt_id)
        request = db.get(CaptureRequest, prepared.claim.request_id)
        if event is None or attempt is None or request is None:
            return True
        attempt.provider_record_id = snapshot.reference.record_id
        attempt.state = _STATE_MAP[snapshot.status]
        attempt.provider_status = snapshot.provider_status
        attempt.last_provider_contact_at = timestamp
        request.status = CaptureRequestStatus.ACCEPTED
        event.status = OutboxStatus.DONE
        event.locked_by = None
        event.locked_at = None
        db.commit()
    return True
