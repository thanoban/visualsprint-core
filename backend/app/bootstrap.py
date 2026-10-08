"""Explicit application factories. Construction does not issue model requests."""

from app.config import get_settings
from app.interfaces.llm import LlmClient


def make_llm() -> LlmClient:
    provider = get_settings().llm_provider
    if provider == "gemini":
        from app.adapters.llm_gemini_vertex import GeminiVertexLlmClient

        return GeminiVertexLlmClient()
    if provider == "vertex":
        from app.adapters.llm_vertex import VertexLlmClient

        return VertexLlmClient()
    if provider == "foundry":
        from app.adapters.llm_foundry import FoundryLlmClient

        return FoundryLlmClient()
    raise ValueError("llm_provider_not_supported")
