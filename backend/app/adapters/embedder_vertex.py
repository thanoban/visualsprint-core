"""Vertex AI Embedder adapter — gemini-embedding-001.

`output_dimensionality=1024` is set explicitly to match `KnowledgeItem.embedding`
(`Vector(1024)`, app/db/models.py) — gemini-embedding-001 defaults to a larger
size, so this is required, not cosmetic.

Uses the same `google.genai` SDK and `gemini_region` (us-central1) as
`GeminiVertexLlmClient` — gemini-embedding-001 is available in us-central1,
not us-east5 (which was `vertex_region`, the Claude-on-Vertex region).
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from app.config import get_settings

if TYPE_CHECKING:
    from google import genai as _genai

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
        # gemini-embedding-001 lives in us-central1 (same as GeminiVertexLlmClient),
        # not us-east5 (vertex_region, which was the Claude-on-Vertex region).
        self._region = region or settings.gemini_region
        self._client: Any = None

    def _ensure_client(self) -> Any:
        if self._client is None:
            from google import genai

            self._client = genai.Client(
                vertexai=True, project=self._project_id, location=self._region
            )
        return self._client

    async def embed(self, text: str) -> list[float]:
        from google.genai import types

        client = self._ensure_client()
        result = await asyncio.to_thread(
            client.models.embed_content,
            model=EMBEDDING_MODEL,
            contents=text,
            config=types.EmbedContentConfig(
                output_dimensionality=EMBEDDING_DIMENSIONALITY,
                task_type="RETRIEVAL_QUERY",
            ),
        )
        return list(result.embeddings[0].values)
