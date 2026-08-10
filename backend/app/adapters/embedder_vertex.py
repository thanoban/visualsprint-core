"""Vertex AI Embedder adapter — gemini-embedding-001.

`output_dimensionality=1024` is set explicitly to match `KnowledgeItem.embedding`
(`Vector(1024)`, app/db/models.py) — gemini-embedding-001 defaults to a larger
size, so this is required, not cosmetic. Reuses the same GCP project/region as
`VertexLlmClient` (app.config.Settings.vertex_project_id/vertex_region) — one
set of cloud credentials covers both, per CLAUDE.md.

The Vertex embedding SDK has no async client as of this writing, so `embed()`
runs the sync call in a thread rather than blocking the event loop.
"""

import asyncio

from app.config import get_settings

EMBEDDING_MODEL = "gemini-embedding-001"
EMBEDDING_DIMENSIONALITY = 1024  # must match KnowledgeItem.embedding's Vector(1024)


def _resolve_project_id(explicit: str | None) -> str:
    if explicit:
        return explicit
    from google.auth import default as google_auth_default

    _, project_id = google_auth_default()
    if not project_id:
        raise RuntimeError(
            "vertex_project_id not set and no default GCP project found via "
            "Application Default Credentials"
        )
    return project_id


class VertexEmbedder:
    """`Embedder` Protocol implementation targeting Vertex AI's embedding API."""

    def __init__(self, project_id: str | None = None, region: str | None = None) -> None:
        settings = get_settings()
        self._project_id = _resolve_project_id(project_id or settings.vertex_project_id)
        self._region = region or settings.vertex_region
        self._model = None

    def _ensure_model(self):
        if self._model is None:
            import vertexai
            from vertexai.language_models import TextEmbeddingModel

            vertexai.init(project=self._project_id, location=self._region)
            self._model = TextEmbeddingModel.from_pretrained(EMBEDDING_MODEL)
        return self._model

    async def embed(self, text: str) -> list[float]:
        from vertexai.language_models import TextEmbeddingInput

        model = self._ensure_model()
        inp = TextEmbeddingInput(text, task_type="RETRIEVAL_QUERY")
        result = await asyncio.to_thread(
            model.get_embeddings, [inp], output_dimensionality=EMBEDDING_DIMENSIONALITY
        )
        return result[0].values
