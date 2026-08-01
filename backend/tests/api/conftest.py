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

from app.db.base import Base, get_db
from app.main import app


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
def client(db_session):
    def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    try:
        with TestClient(app) as c:
            yield c
    finally:
        app.dependency_overrides.clear()
