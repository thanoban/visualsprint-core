"""Unit coverage for app.adapters.embedder_vertex's project-id resolution --
the one piece of VertexEmbedder that's pure logic and doesn't need a live
Vertex AI model or GCP credentials. embed() itself needs a real Vertex
model and is out of scope here, same as every other Vertex-backed path in
this codebase pending live credentials."""

import pytest

from app.adapters.embedder_vertex import VertexEmbedder
from app.config import get_settings


@pytest.fixture(autouse=True)
def _isolate_from_local_env(monkeypatch):
    # backend/.env may carry a real VS_VERTEX_PROJECT_ID for local dev
    # (SettingsConfigDict(env_file=".env") loads it automatically). Real env
    # vars take precedence over the .env file in pydantic-settings'
    # resolution order, but delenv does NOT shadow a .env-file value --
    # pydantic-settings just reads it straight from the file when the var
    # isn't in os.environ. Setting it to "" is the only way to actually
    # override it for this test, since an empty string is falsy and the
    # adapter's `explicit or settings.vertex_project_id` treats it as unset.
    monkeypatch.setenv("VS_VERTEX_PROJECT_ID", "")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_uses_the_explicit_project_id_argument_over_settings(monkeypatch):
    monkeypatch.setattr(
        "google.auth.default", lambda: (None, "should-not-be-used")
    )
    embedder = VertexEmbedder(project_id="explicit-project", region="us-central1")

    assert embedder._project_id == "explicit-project"
    assert embedder._region == "us-central1"


def test_falls_back_to_application_default_credentials_project(monkeypatch):
    monkeypatch.setattr("google.auth.default", lambda: (None, "adc-project"))

    embedder = VertexEmbedder()

    assert embedder._project_id == "adc-project"


def test_raises_when_no_project_id_is_configured_or_discoverable(monkeypatch):
    monkeypatch.setattr("google.auth.default", lambda: (None, None))

    with pytest.raises(RuntimeError, match="vertex_project_id not set"):
        VertexEmbedder()


def test_falls_back_to_settings_region_when_none_given(monkeypatch):
    monkeypatch.setattr("google.auth.default", lambda: (None, "adc-project"))

    embedder = VertexEmbedder()

    assert embedder._region is not None
