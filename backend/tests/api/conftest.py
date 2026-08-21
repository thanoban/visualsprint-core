"""Shared fixtures for backend/tests/api.

Default: in-memory SQLite (fast, zero-setup). Set VS_TEST_DATABASE_URL to a
real Postgres URL to run the full suite against Postgres instead — this is
what CI does, and it catches dialect-specific bugs (pgvector, HNSW, FTS) that
SQLite silently masks.

SQLite can't represent the pgvector `Vector` column on `KnowledgeItem.embedding`,
so `test_chat.py` marks the vector-similarity path and skips it when on SQLite.
"""

import os

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool, StaticPool

from app.auth import dependency as auth_dep
from app.db.base import Base, get_db
from app.db.models import User
from app.main import app

FAKE_USER = User(id="test-user-0000-0000-0000-000000000000", email="test@example.com")

_PG_URL = os.environ.get("VS_TEST_DATABASE_URL")


@pytest.fixture
def db_session():
    if _PG_URL:
        # Postgres: real schema, real dialect — catches pgvector/FTS/HNSW issues.
        # NullPool so each test gets a fresh connection, never a stale one.
        engine = create_engine(_PG_URL, poolclass=NullPool)
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False)
        session = session_local()
        try:
            yield session
        finally:
            session.rollback()
            session.close()
            Base.metadata.drop_all(engine)
            engine.dispose()
    else:
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
