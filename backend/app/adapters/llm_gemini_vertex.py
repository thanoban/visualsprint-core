"""LlmClient implementation — Gemini via Vertex AI.

Default LLM provider as of 2026-08-11, replacing Claude-on-Vertex
(app/adapters/llm_vertex.py, kept but no longer the default) as the
project's primary LlmClient. Reason: Anthropic's partner models on Vertex
(app/adapters/llm_vertex.py, llm_foundry.py) sit behind Google's
per-base-model quota system, which defaults new projects to zero quota for
`claude-sonnet-5` specifically (a manual quota-increase request is required
-- see https://cloud.google.com/vertex-ai/docs/generative-ai/quotas-genai).
Gemini is Google's own first-party model on Vertex and carries no such
partner-quota gate, so it unblocks the agent pipeline immediately at zero
extra cost/friction for a budget-constrained deploy. This is a documented
exception to CLAUDE.md's original "agents run on Claude" decision, per the
project's own rule that a new fact contradicting a locked decision must be
stated explicitly rather than silently drifted around.

Structured output uses Gemini's native `response_schema` (a Pydantic model
passed directly) rather than Claude's forced-tool-use workaround -- Gemini
supports schema-constrained JSON generation directly, so no tool-call
indirection is needed.
"""

from typing import TypeVar

import structlog
from pydantic import BaseModel, ValidationError
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from app.config import get_settings
from app.interfaces.llm import LlmUsage

log = structlog.get_logger()

T = TypeVar("T", bound=BaseModel)


class SchemaValidationError(Exception):
    """Raised when the model's structured output fails Pydantic validation."""


def _sniff_media_type(data: bytes) -> str:
    """Same minimal magic-byte check as llm_vertex.py -- kept duplicated,
    matching this codebase's per-adapter convention (see app/adapters/asr_*.py)."""
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    raise ValueError("unrecognized image format — expected JPEG or PNG magic bytes")


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


class GeminiVertexLlmClient:
    """`LlmClient` Protocol implementation targeting Gemini on Vertex AI."""

    def __init__(self, project_id: str | None = None, region: str | None = None) -> None:
        settings = get_settings()
        self._project_id = _resolve_project_id(project_id or settings.vertex_project_id)
        # Gemini's region availability differs from Claude's partner-model
        # availability (verified empirically against this project: Claude
        # needed region="global" and was still quota-blocked there, while
        # Gemini works cleanly in "us-central1") -- a separate setting from
        # vertex_region avoids re-coupling the two providers' region needs.
        self._region = region or settings.gemini_region
        from google import genai

        self._client = genai.Client(
            vertexai=True, project=self._project_id, location=self._region
        )

    @retry(
        retry=retry_if_exception_type(SchemaValidationError),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=8),
        reraise=True,
    )
    async def complete_structured(
        self,
        *,
        model: str,
        system: str,
        user_content: str,
        schema: type[T],
        max_tokens: int = 4096,
        images: list[bytes] = [],  # noqa: B006 — never mutated, see interfaces/llm.py
    ) -> tuple[T, LlmUsage]:
        from google.genai import types

        contents: list = []
        if images:
            # Images first, text last — same ordering convention as
            # llm_vertex.py/llm_foundry.py for multi-modal messages where
            # the text refers to the image(s).
            for image_bytes in images:
                contents.append(
                    types.Part.from_bytes(
                        data=image_bytes, mime_type=_sniff_media_type(image_bytes)
                    )
                )
        contents.append(user_content)

        response = await self._client.aio.models.generate_content(
            model=model,
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=system,
                response_mime_type="application/json",
                response_schema=schema,
                max_output_tokens=max_tokens,
            ),
        )
        usage = LlmUsage(
            input_tokens=response.usage_metadata.prompt_token_count,
            output_tokens=response.usage_metadata.candidates_token_count,
            model=model,
        )
        if not response.text:
            raise SchemaValidationError("model returned no text (blocked or empty response)")
        try:
            result = schema.model_validate_json(response.text)
        except ValidationError as exc:
            log.warning("llm.schema_invalid", schema=schema.__name__, error=str(exc))
            raise SchemaValidationError(str(exc)) from exc
        return result, usage
