"""Shared fixtures for backend/tests/agents — in-memory SQLite + a scriptable
fake LlmClient so agent logic is testable with zero Vertex AI credentials.
"""

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.interfaces.llm import LlmUsage


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


class FakeLlmClient:
    """Returns a pre-scripted schema instance and records every call for
    inspection — e.g. asserting the verification prompt never contains
    Context Intelligence's rationale text (rule 3)."""

    def __init__(self, response):
        self._response = response
        self.calls: list[dict] = []

    async def complete_structured(self, *, model, system, user_content, schema, max_tokens=4096):
        self.calls.append(
            {"model": model, "system": system, "user_content": user_content, "schema": schema}
        )
        assert isinstance(self._response, schema), (
            f"FakeLlmClient scripted with {type(self._response)} but agent requested {schema}"
        )
        return self._response, LlmUsage(input_tokens=10, output_tokens=10, model=model)
