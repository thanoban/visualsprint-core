"""Unit coverage for app.adapters.embedder_vertex's project-id resolution --
the one piece of VertexEmbedder that's pure logic and doesn't need a live
Vertex AI model or GCP credentials. embed() itself needs a real Vertex
model and is out of scope here, same as every other Vertex-backed path in
this codebase pending live credentials."""

import pytest

import app.adapters.embedder_vertex as embedder_vertex
from app.adapters.embedder_vertex import VertexEmbedder


def test_uses_the_explicit_project_id_argument_over_settings(monkeypatch):
    monkeypatch.setattr(
        embedder_vertex, "google_auth_default", lambda: (None, "should-not-be-used")
    )
    embedder = VertexEmbedder(project_id="explicit-project", region="us-central1")

    assert embedder._project_id == "explicit-project"
    assert embedder._region == "us-central1"


def test_falls_back_to_application_default_credentials_project(monkeypatch):
    monkeypatch.setattr(embedder_vertex, "google_auth_default", lambda: (None, "adc-project"))

    embedder = VertexEmbedder()

    assert embedder._project_id == "adc-project"


def test_raises_when_no_project_id_is_configured_or_discoverable(monkeypatch):
    monkeypatch.setattr(embedder_vertex, "google_auth_default", lambda: (None, None))

    with pytest.raises(RuntimeError, match="vertex_project_id not set"):
        VertexEmbedder()


def test_falls_back_to_settings_region_when_none_given(monkeypatch):
    monkeypatch.setattr(embedder_vertex, "google_auth_default", lambda: (None, "adc-project"))

    embedder = VertexEmbedder()

    assert embedder._region is not None
