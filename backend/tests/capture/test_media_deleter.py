"""Tests for the temporary media deletion lifecycle (F06)."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.capture.media_deleter import (
    MAX_RETENTION_SECONDS,
    delete_pending,
    list_overdue,
    register_media_ref,
)
from app.db.base import Base
from app.db.models import (
    CaptureMediaRef,
    CaptureRequest,
    CaptureRequestStatus,
    CaptureStopState,
    MediaDeletionState,
    Meeting,
    Org,
    User,
)


class FakeSecretStore:
    def __init__(self, *, raise_on_delete=False):
        self.deleted = []
        self._raise = raise_on_delete

    async def put(self, name, value):
        pass

    async def get(self, name):
        return ""

    async def delete(self, name):
        if self._raise:
            raise RuntimeError("blobstore unavailable")
        self.deleted.append(name)


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as session:
        session.add(Org(id="org-1", name="Acme"))
        session.add(User(id="user-1", email="u@example.com"))
        session.add(Meeting(id="meeting-1", org_id="org-1", title="Call", platform="meet"))
        session.add(
            CaptureRequest(
                id="req-1",
                org_id="org-1",
                meeting_id="meeting-1",
                requested_by="user-1",
                platform="google_meet",
                native_meeting_id="abc-defg-hij",
                meeting_url_secret_ref="meeting-url",
                policy_snapshot={},
                input_hash="a" * 64,
                idempotency_key="key-1",
                status=CaptureRequestStatus.FINALIZED,
            )
        )
        session.commit()
    try:
        yield factory
    finally:
        engine.dispose()


async def run_delete(factory, *, store, now):
    return await delete_pending(factory, secret_store=store, now=now)


def test_register_caps_delete_after_at_24h(db):
    capture_started = datetime(2026, 10, 8, 12, 0, 0, tzinfo=UTC)
    with db() as session:
        ref = register_media_ref(
            session,
            org_id="org-1",
            request_id="req-1",
            kind="audio_chunk",
            store_ref="chunks/org-1/req-1/01.webm",
            capture_started_at=capture_started,
        )
        session.commit()
        assert (ref.delete_after - capture_started).total_seconds() == MAX_RETENTION_SECONDS


def test_delete_pending_removes_ref_after_deadline(db):
    capture_started = datetime(2026, 10, 8, 12, 0, 0, tzinfo=UTC)
    with db() as session:
        ref = register_media_ref(
            session,
            org_id="org-1",
            request_id="req-1",
            kind="full_audio",
            store_ref="audio/org-1/req-1/full.wav",
            capture_started_at=capture_started,
        )
        session.commit()
        ref_id = ref.id

    store = FakeSecretStore()
    now = capture_started + timedelta(seconds=MAX_RETENTION_SECONDS + 1)
    import asyncio

    counts = asyncio.run(run_delete(db, store=store, now=now))

    assert counts["deleted"] == 1
    assert "audio/org-1/req-1/full.wav" in store.deleted
    with db() as session:
        ref = session.get(CaptureMediaRef, ref_id)
        assert ref.state == MediaDeletionState.DELETED
        assert ref.deleted_at is not None


def test_delete_pending_skips_refs_before_deadline(db):
    capture_started = datetime(2026, 10, 8, 12, 0, 0, tzinfo=UTC)
    with db() as session:
        register_media_ref(
            session,
            org_id="org-1",
            request_id="req-1",
            kind="audio_chunk",
            store_ref="chunks/org-1/req-1/01.webm",
            capture_started_at=capture_started,
        )
        session.commit()

    store = FakeSecretStore()
    now = capture_started + timedelta(seconds=3600)  # only 1 hour in, deadline is 24h
    import asyncio

    counts = asyncio.run(run_delete(db, store=store, now=now))
    assert counts["deleted"] == 0
    assert store.deleted == []


def test_overdue_flag_set_when_store_unavailable(db):
    capture_started = datetime(2026, 10, 8, 12, 0, 0, tzinfo=UTC)
    with db() as session:
        ref = register_media_ref(
            session,
            org_id="org-1",
            request_id="req-1",
            kind="provider_recording",
            store_ref="provider/rec-1",
            capture_started_at=capture_started,
        )
        session.commit()
        ref_id = ref.id

    store = FakeSecretStore(raise_on_delete=True)
    now = capture_started + timedelta(seconds=MAX_RETENTION_SECONDS + 60)
    import asyncio

    counts = asyncio.run(run_delete(db, store=store, now=now))

    assert counts["overdue_flagged"] == 1
    with db() as session:
        ref = session.get(CaptureMediaRef, ref_id)
        assert ref.overdue is True
        assert ref.state == MediaDeletionState.PENDING
        assert ref.delete_attempts == 1


def test_failed_after_max_attempts(db):
    capture_started = datetime(2026, 10, 8, 12, 0, 0, tzinfo=UTC)
    with db() as session:
        ref = register_media_ref(
            session,
            org_id="org-1",
            request_id="req-1",
            kind="audio_chunk",
            store_ref="chunks/org-1/req-1/02.webm",
            capture_started_at=capture_started,
        )
        # Simulate 4 prior failures
        ref.delete_attempts = 4
        session.commit()
        ref_id = ref.id

    store = FakeSecretStore(raise_on_delete=True)
    now = capture_started + timedelta(seconds=MAX_RETENTION_SECONDS + 60)
    import asyncio

    asyncio.run(run_delete(db, store=store, now=now))

    with db() as session:
        ref = session.get(CaptureMediaRef, ref_id)
        assert ref.state == MediaDeletionState.FAILED
        assert ref.delete_attempts == 5


def test_list_overdue_returns_pending_past_deadline(db):
    capture_started = datetime(2026, 10, 8, 12, 0, 0, tzinfo=UTC)
    with db() as session:
        ref = register_media_ref(
            session,
            org_id="org-1",
            request_id="req-1",
            kind="full_audio",
            store_ref="audio/org-1/req-1/late.wav",
            capture_started_at=capture_started,
        )
        session.commit()

    now = capture_started + timedelta(seconds=MAX_RETENTION_SECONDS + 3600)
    with db() as session:
        overdue = list_overdue(session, now=now)
        assert len(overdue) == 1
        assert overdue[0].store_ref == "audio/org-1/req-1/late.wav"


def test_list_overdue_excludes_deleted_refs(db):
    capture_started = datetime(2026, 10, 8, 12, 0, 0, tzinfo=UTC)
    with db() as session:
        ref = register_media_ref(
            session,
            org_id="org-1",
            request_id="req-1",
            kind="full_audio",
            store_ref="audio/org-1/req-1/done.wav",
            capture_started_at=capture_started,
        )
        ref.state = MediaDeletionState.DELETED
        ref.deleted_at = capture_started + timedelta(hours=20)
        session.commit()

    now = capture_started + timedelta(seconds=MAX_RETENTION_SECONDS + 3600)
    with db() as session:
        overdue = list_overdue(session, now=now)
        assert overdue == []
