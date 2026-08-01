"""LlmClient implementation — Claude via Vertex AI.

Transport is `anthropic[vertex]`'s AnthropicVertex client, authenticated with
GCP Application Default Credentials (`google.auth.default()`), never an API
key. Structured output is obtained via forced tool-use: the Pydantic schema
is turned into a single tool whose input_schema mirrors the model, the model
is forced to call it, and the tool_use input is validated back into the
Pydantic type. Invalid output is retried (tenacity) before raising.
"""

from typing import TypeVar

import structlog
from anthropic import AnthropicVertex
from google.auth import default as google_auth_default
from pydantic import BaseModel, ValidationError
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from app.config import get_settings
from app.interfaces.llm import LlmUsage

log = structlog.get_logger()

T = TypeVar("T", bound=BaseModel)

_TOOL_NAME = "emit_result"


class SchemaValidationError(Exception):
    """Raised when the model's structured output fails Pydantic validation."""


def _resolve_project_id(explicit: str | None) -> str:
    if explicit:
        return explicit
    _, project_id = google_auth_default()
    if not project_id:
        raise RuntimeError(
            "vertex_project_id not set and no default GCP project found via "
            "Application Default Credentials"
        )
    return project_id


class VertexLlmClient:
    """`LlmClient` Protocol implementation targeting Claude on Vertex AI."""

    def __init__(self, project_id: str | None = None, region: str | None = None) -> None:
        settings = get_settings()
        self._project_id = _resolve_project_id(project_id or settings.vertex_project_id)
        self._region = region or settings.vertex_region
        self._client = AnthropicVertex(project_id=self._project_id, region=self._region)

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
    ) -> tuple[T, LlmUsage]:
        tool = {
            "name": _TOOL_NAME,
            "description": f"Emit a result matching the {schema.__name__} schema.",
            "input_schema": schema.model_json_schema(),
        }
        response = self._client.messages.create(
            model=model,
            system=system,
            max_tokens=max_tokens,
            tools=[tool],
            tool_choice={"type": "tool", "name": _TOOL_NAME},
            messages=[{"role": "user", "content": user_content}],
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
