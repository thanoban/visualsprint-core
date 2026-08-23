"""LlmClient implementation — Claude via Microsoft Foundry (Azure).

Transport is `anthropic`'s AnthropicFoundry client (part of the base SDK,
no extra install), authenticated with an API key from the Foundry resource
(app.config.Settings.foundry_api_key/foundry_resource) — never hardcoded.
Structured output uses the same forced-tool-use technique as
llm_vertex.py's VertexLlmClient: both sit behind the LlmClient Protocol and
must be interchangeable without agent code knowing which vendor is live.

Exists alongside VertexLlmClient, not in place of it — CLAUDE.md's original
"Vertex AI, not the direct Anthropic API" decision assumed Claude had no
other cloud-native transport; Claude went GA on Microsoft Foundry in
June 2026, so this is the documented exception the project's own rules
call for ("if a new fact contradicts one of these, say so explicitly").
Vertex stays the default (VS_LLM_PROVIDER=vertex); Foundry is a swap for
when GCP billing is the blocker, not a permanent replacement.
"""

import base64
from typing import TypeVar

import structlog
from pydantic import BaseModel, ValidationError
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from app.config import get_settings
from app.interfaces.llm import LlmUsage

log = structlog.get_logger()

T = TypeVar("T", bound=BaseModel)

_TOOL_NAME = "emit_result"


class SchemaValidationError(Exception):
    """Raised when the model's structured output fails Pydantic validation."""


def _sniff_media_type(data: bytes) -> str:
    """Same minimal magic-byte check as llm_vertex.py -- kept duplicated
    rather than shared, matching this codebase's per-adapter convention
    (see app/adapters/asr_*.py)."""
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    raise ValueError("unrecognized image format — expected JPEG or PNG magic bytes")


class FoundryLlmClient:
    """`LlmClient` Protocol implementation targeting Claude on Microsoft Foundry."""

    def __init__(self, api_key: str | None = None, resource: str | None = None) -> None:
        settings = get_settings()
        resolved_key = api_key or settings.foundry_api_key
        resolved_resource = resource or settings.foundry_resource
        if not resolved_key or not resolved_resource:
            raise RuntimeError(
                "foundry_api_key and foundry_resource must both be set "
                "(VS_FOUNDRY_API_KEY / VS_FOUNDRY_RESOURCE) to use the "
                "Microsoft Foundry LlmClient"
            )
        from anthropic import AnthropicFoundry

        self._client = AnthropicFoundry(api_key=resolved_key, resource=resolved_resource)

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
        temperature: float = 0.0,
        images: list[bytes] = [],  # noqa: B006 — never mutated, see interfaces/llm.py
    ) -> tuple[T, LlmUsage]:
        tool = {
            "name": _TOOL_NAME,
            "description": f"Emit a result matching the {schema.__name__} schema.",
            "input_schema": schema.model_json_schema(),
        }
        content: str | list[dict] = user_content
        if images:
            # Images first, text last — Anthropic's documented ordering for
            # multi-modal messages where the text refers to the image(s).
            content = [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": _sniff_media_type(image_bytes),
                        "data": base64.b64encode(image_bytes).decode("ascii"),
                    },
                }
                for image_bytes in images
            ]
            content.append({"type": "text", "text": user_content})
        response = self._client.messages.create(
            model=model,
            system=system,
            max_tokens=max_tokens,
            temperature=temperature,
            tools=[tool],
            tool_choice={"type": "tool", "name": _TOOL_NAME},
            messages=[{"role": "user", "content": content}],
        )
        usage = LlmUsage(
            input_tokens=response.usage.input_tokens,
            output_tokens=response.usage.output_tokens,
            model=model,
        )
        tool_use = next(
            (block for block in response.content if block.type == "tool_use"),
            None,
        )
        if tool_use is None:
            raise SchemaValidationError("model did not return a tool_use block")
        try:
            result = schema.model_validate(tool_use.input)
        except ValidationError as exc:
            log.warning("llm.schema_invalid", schema=schema.__name__, error=str(exc))
            raise SchemaValidationError(str(exc)) from exc
        return result, usage
