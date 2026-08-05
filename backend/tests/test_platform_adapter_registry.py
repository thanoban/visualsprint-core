"""worker._get_platform_adapter_for_session() is the acquire stage's only
route to a real PlatformAdapter for Mode A2 -- a silently-missing entry
here means a platform that looks wired everywhere else (docs, tests, the
adapter class itself) actually can't ever be reached in production. Cheap
regression guard against that class of gap.

Previously this registry was a single memoized dict built once and shared
across every org (worker._platform_adapters, cached forever) -- that was
itself the multi-tenant bug fixed alongside this rewrite: two orgs
capturing on the same platform would have shared one token provider. The
replacement builds a fresh, per-org adapter on every call instead.
"""

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.orchestrator.worker as worker
from app.capture.meet_adapter import MeetAdapter
from app.capture.teams_adapter import TeamsAdapter
from app.capture.zoom_adapter import ZoomAdapter
from app.db.base import Base
from app.interfaces.platform import CaptureMode


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


@pytest.fixture(autouse=True)
def _no_test_injection():
    # Force the real per-org construction path regardless of test order --
    # some other test module may have left an override in place.
    worker._platform_adapters = None
    yield
    worker._platform_adapters = None


def test_every_a2_platform_resolves_to_its_adapter_class(db):
    assert isinstance(worker._get_platform_adapter_for_session(db, "org-1", "meet"), MeetAdapter)
    assert isinstance(worker._get_platform_adapter_for_session(db, "org-1", "zoom"), ZoomAdapter)
    assert isinstance(worker._get_platform_adapter_for_session(db, "org-1", "teams"), TeamsAdapter)


def test_every_resolved_adapter_reports_official_artifacts_mode(db):
    for platform in ("meet", "zoom", "teams"):
        adapter = worker._get_platform_adapter_for_session(db, "org-1", platform)
        assert adapter.mode == CaptureMode.OFFICIAL_ARTIFACTS


def test_unknown_platform_resolves_to_none_not_a_crash(db):
    assert worker._get_platform_adapter_for_session(db, "org-1", "unknown-platform") is None


def test_adapters_are_built_fresh_per_call_not_shared_across_orgs(db):
    """The old registry's memoization ("first is second") was itself part
    of the bug -- a fresh adapter (and fresh token provider) per call is
    what makes per-org isolation possible."""
    first = worker._get_platform_adapter_for_session(db, "org-1", "zoom")
    second = worker._get_platform_adapter_for_session(db, "org-2", "zoom")
    assert first is not second
