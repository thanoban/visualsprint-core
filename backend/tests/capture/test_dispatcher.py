from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.capture.dispatcher import dispatch_next
from app.capture.requests import create_capture_request
from app.db.base import Base
from app.db.models import (
    CaptureAttempt,
    CaptureAttemptState,
    CaptureRequest,
    CaptureRequestStatus,
    Meeting,
    Org,
    OrgMember,
    OutboxEvent,
    OutboxStatus,
    ProviderBinding,
    User,
)
from app.interfaces.capture_provider import (
    CaptureProviderError,
    CaptureReference,
    CaptureSnapshot,
    CaptureStatus,
    MeetingTarget,
)


class FakeSecrets:
    def __init__(self, values):
        self.values = values

    async def get(self, name):
        if name not in self.values:
            raise KeyError(name)
        return self.values[name]

    async def put(self, name, value):
        self.values[name] = value

    async def delete(self, name):
        self.values.pop(name, None)


class FakeProvider:
    def __init__(self, error=None):
        self.error = error
        self.calls = []

    async def start(self, target):
        self.calls.append(target)
        if self.error:
            raise self.error
        reference = CaptureReference(
            provider="vexa",
            record_id="record-1",
            platform=target.platform,
            native_meeting_id=target.native_meeting_id,
        )
        return CaptureSnapshot(
            reference=reference,
            status=CaptureStatus.JOINING,
            provider_status="requested",
        )


class FakeResolver:
    def __init__(self, provider):
        self.provider = provider
        self.binding_ids = []

    async def resolve(self, binding):
        self.binding_ids.append(binding.id)
        return self.provider


@pytest.fixture
def state():
    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as db:
        db.add_all(
            [
                Org(id="org-1", name="One"),
                User(id="user-1", email="one@example.com"),
                OrgMember(org_id="org-1", user_id="user-1", role="owner"),
                Meeting(id="meeting-1", org_id="org-1", title="Pilot", platform="meet"),
                ProviderBinding(
                    id="binding-1",
                    org_id="org-1",
                    provider="vexa",
                    endpoint_ref="config://vexa/primary",
                    account_scope_id="account-one",
                    secret_ref="secret://vexa/key",
                ),
            ]
        )
        db.commit()
        create_capture_request(
            db,
            org_id="org-1",
            meeting_id="meeting-1",
            requested_by="user-1",
            idempotency_key="request-1",
            target=MeetingTarget.from_url("https://meet.google.com/abc-defg-hij"),
            meeting_url_secret_ref="secret://meeting/url",
            policy_snapshot={"capture": True},
            estimated_seconds=600,
            now=datetime(2026, 10, 8, tzinfo=UTC),
        )
        db.commit()
    try:
        yield factory
    finally:
        engine.dispose()


async def run(state, provider, *, secrets=None, now=None):
    return await dispatch_next(
        state,
        secret_store=secrets
        or FakeSecrets({"secret://meeting/url": "https://meet.google.com/abc-defg-hij"}),
        provider_resolver=FakeResolver(provider),
        worker_id="worker-1",
        now=now or datetime(2026, 10, 8, tzinfo=UTC),
    )


@pytest.mark.asyncio
async def test_dispatch_commits_one_attempt_then_records_provider_reference(state):
    provider = FakeProvider()
    assert await run(state, provider)

    with state() as db:
        request = db.execute(select(CaptureRequest)).scalar_one()
        attempt = db.execute(select(CaptureAttempt)).scalar_one()
        event = db.execute(
            select(OutboxEvent).where(OutboxEvent.operation == "capture.dispatch")
        ).scalar_one()
        assert request.status == CaptureRequestStatus.ACCEPTED
        assert attempt.state == CaptureAttemptState.JOINING
        assert attempt.provider_record_id == "record-1"
        assert attempt.last_provider_contact_at is not None
        assert event.status == OutboxStatus.DONE
        assert event.locked_by is None
    assert len(provider.calls) == 1

    assert not await run(state, provider)
    assert len(provider.calls) == 1


@pytest.mark.asyncio
async def test_ambiguous_dispatch_is_reconciled_and_never_reposted(state):
    provider = FakeProvider(CaptureProviderError("timeout", uncertain=True))
    assert await run(state, provider)

    with state() as db:
        request = db.execute(select(CaptureRequest)).scalar_one()
        attempt = db.execute(select(CaptureAttempt)).scalar_one()
        operations = db.scalars(select(OutboxEvent.operation)).all()
        assert request.status == CaptureRequestStatus.DISPATCH_UNKNOWN
        assert attempt.state == CaptureAttemptState.UNKNOWN
        assert operations.count("capture.dispatch") == 1
        assert operations.count("capture.reconcile") == 1

    assert not await run(state, provider)
    assert len(provider.calls) == 1


@pytest.mark.asyncio
async def test_missing_meeting_secret_fails_without_provider_call(state):
    provider = FakeProvider()
    assert await run(state, provider, secrets=FakeSecrets({}))

    with state() as db:
        request = db.execute(select(CaptureRequest)).scalar_one()
        attempt = db.execute(select(CaptureAttempt)).scalar_one()
        assert request.status == CaptureRequestStatus.FAILED
        assert attempt.state == CaptureAttemptState.FAILED
        assert attempt.error_code == "capture_dispatch_configuration_error"
    assert provider.calls == []


@pytest.mark.asyncio
async def test_workspace_concurrency_limit_reschedules_without_creating_attempt(state):
    with state() as db:
        for number in range(1, 6):
            other_request = CaptureRequest(
                id=f"other-request-{number}",
                org_id="org-1",
                meeting_id="meeting-1",
                requested_by="user-1",
                platform="google_meet",
                native_meeting_id=f"other-{number}",
                meeting_url_secret_ref=f"secret://other/{number}",
                policy_snapshot={},
                input_hash=f"{number:064d}",
                idempotency_key=f"other-{number}",
            )
            db.add(other_request)
            db.add(
                CaptureAttempt(
                    org_id="org-1",
                    request_id=other_request.id,
                    attempt_no=1,
                    provider_binding_id="binding-1",
                    state=CaptureAttemptState.CAPTURING,
                    provider_record_id=f"existing-{number}",
                )
            )
        db.commit()

    provider = FakeProvider()
    assert await run(state, provider)
    assert provider.calls == []
    with state() as db:
        event = db.execute(
            select(OutboxEvent).where(OutboxEvent.operation == "capture.dispatch")
        ).scalar_one()
        assert event.status == OutboxStatus.PENDING
        assert event.run_at.replace(tzinfo=UTC) == datetime(2026, 10, 8, tzinfo=UTC) + timedelta(
            seconds=30
        )


@pytest.mark.asyncio
async def test_recovered_claim_with_existing_attempt_requires_reconciliation(state):
    with state() as db:
        request = db.execute(select(CaptureRequest)).scalar_one()
        db.add(
            CaptureAttempt(
                org_id="org-1",
                request_id=request.id,
                attempt_no=1,
                provider_binding_id="binding-1",
                state=CaptureAttemptState.SCHEDULED,
            )
        )
        db.commit()

    provider = FakeProvider()
    assert await run(state, provider)
    assert provider.calls == []
    with state() as db:
        request = db.execute(select(CaptureRequest)).scalar_one()
        assert request.status == CaptureRequestStatus.RECONCILIATION_REQUIRED
        assert db.scalar(
            select(func.count())
            .select_from(OutboxEvent)
            .where(OutboxEvent.operation == "capture.reconcile")
        ) == 1
