"""Embedder swap point — turns text into the vector `KnowledgeItem.embedding`
(Vector(1024), app/db/models.py) and pgvector similarity search need.

Bought today: Vertex AI (app.adapters.embedder_vertex.VertexEmbedder), same
GCP project/credentials as VertexLlmClient. Downstream code (chat retrieval,
Memory Intelligence's related-item search) consumes only `list[float]` and
never imports a vendor SDK directly.
"""

from typing import Protocol


class Embedder(Protocol):
    async def embed(self, text: str) -> list[float]:
        """Return an embedding vector for `text`. Length must match whatever
        Vector(N) column the caller writes it into (1024 today)."""
        ...
