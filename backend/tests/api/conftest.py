"""Shared fixtures for backend/tests/api — isolated in-memory SQLite DB per test.

Production runs on Postgres + pgvector; SQLite can't faithfully represent the
pgvector `Vector` column on `KnowledgeItem.embedding` (see backend/app/db/models.py),
so `test_chat.py` marks the vector-similarity-specific path clearly and skips
executing it against real data — the FTS retrieval path (the working path today)
is fully exercised here, against the same code the postgres branch shares.
"""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.auth import dependency as auth_dep
from app.db.base import Base, get_db
from app.db.models import User
from app.main import app

FAKE_USER = User(id="test-user-0000-0000-0000-000000000000", email="test@example.com")


@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session_local = sessionmaker(bind=engine, expire_on_commit=False)
    session = session_local()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


@pytest.fixture
def client(db_session, monkeypatch):
    """Overrides auth for every test in backend/tests/api by default -- a
    fixed fake User plus `is_org_member` always returning True, so the
    400+ tests written before app/auth/ existed don't each need their own
    User/OrgMember rows. Tests that specifically exercise the auth
    boundary (401/403 cases) override these back inside the test itself --
    see tests/api/test_me.py and the require_org_member cases in
    test_oauth.py.

    `is_org_member` is monkeypatched on the app.auth.dependency module
    (not via app.dependency_overrides) because several routers call it
    directly rather than through Depends() -- org_id comes from a request
    body/form field on those routes (chat.py, upload.py, actions.py's
    approve/reject, corrections.py's submit_correction), not the path, so
    it can't be a path-resolved FastAPI dependency the way
    require_org_member is."""

    def _override_get_db():
        yield db_session

    def _override_get_current_user():
        return FAKE_USER

    monkeypatch.setattr(auth_dep, "is_org_member", lambda db, org_id, user: True)
    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[auth_dep.get_current_user] = _override_get_current_user
    try:
        with TestClient(app) as c:
            yield c
    finally:
        app.dependency_overrides.clear()
