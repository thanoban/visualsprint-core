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


class FakeEmbedder:
    """Deterministic fake `Embedder` — same text always yields the same
    vector, and distinct texts yield orthogonal-ish vectors, so tests can
    assert both "an embedding got populated" and (in real-Postgres tests)
    meaningful similarity ordering without needing live Vertex AI credentials."""

    def __init__(self, dim: int = 1024) -> None:
        self.dim = dim
        self.calls: list[str] = []

    async def embed(self, text: str) -> list[float]:
        self.calls.append(text)
        vec = [0.0] * self.dim
        for i, ch in enumerate(text):
            vec[(ord(ch) + i) % self.dim] += 1.0
        norm = sum(v * v for v in vec) ** 0.5 or 1.0
        return [v / norm for v in vec]


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
