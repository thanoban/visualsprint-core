"""Per-call LLM cost accounting and per-org budget enforcement.

`LlmUsage` was already threaded correctly out of every adapter and through
every agent -- and then handed only to `log.info()`. Nothing could attribute
spend to an org, a stage, or a meeting, cap it, or alarm on it. On a
budget-constrained deploy that is the failure mode most likely to actually
cause damage, especially for `model_repair`, which runs on every ASR segment
of every recording.

This module closes that without touching a single agent, by wrapping the
`LlmClient` swap point (CLAUDE.md rule 4) in a decorator that implements the
same Protocol. Call-site context (org, capture session, stage) travels by
contextvar rather than as a parameter, because threading it through five
agents and their helpers would have meant editing exactly the code the
interface boundary exists to insulate.

Accounting rows are written in their **own** short transaction, committed
independently of the stage's. Spend is a fact about money already spent: it
must survive the stage that incurred it rolling back, or the accounting
under-reports precisely when a job is failing and retrying -- the case that
matters most.
"""

from __future__ import annotations

import contextvars
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TypeVar

import structlog
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.interfaces.llm import LlmClient, LlmUsage

log = structlog.get_logger()

T = TypeVar("T", bound=BaseModel)


@dataclass(frozen=True)
class LlmCallContext:
    """Who to bill this call to. Empty outside a stage (e.g. an API-path call)."""

    org_id: str | None = None
    capture_session_id: str | None = None
    stage: str | None = None


# Default None rather than an empty LlmCallContext: a ContextVar default is
# shared process-wide, and "no default object at all" is the unambiguous form.
_current_context: contextvars.ContextVar[LlmCallContext | None] = contextvars.ContextVar(
    "llm_call_context", default=None
)

_NO_CONTEXT = LlmCallContext()


def set_llm_context(context: LlmCallContext) -> contextvars.Token[LlmCallContext | None]:
    return _current_context.set(context)


def reset_llm_context(token: contextvars.Token[LlmCallContext | None]) -> None:
    _current_context.reset(token)


def current_llm_context() -> LlmCallContext:
    """The context to bill to, or an empty one outside a stage."""
    return _current_context.get() or _NO_CONTEXT


class LlmBudgetExceeded(Exception):
    """Raised when an org is over its monthly token budget.

    Deliberately distinct from any vendor error: `app.orchestrator.worker`
    treats it as terminal and fails the session immediately instead of
    retrying. Retrying a budget refusal is exactly how an overspend becomes
    a runaway.
    """


def _month_start(now: datetime) -> datetime:
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def org_tokens_used_this_month(
    db: Session, org_id: str, *, now: datetime | None = None
) -> int:
    """Month-to-date input+output tokens for one org."""
    from app.db.models import LlmCall

    now = now or datetime.now(UTC)
    total = db.execute(
        select(func.coalesce(func.sum(LlmCall.input_tokens + LlmCall.output_tokens), 0)).where(
            LlmCall.org_id == org_id, LlmCall.at >= _month_start(now)
        )
    ).scalar_one()
    return int(total or 0)


def check_org_budget(db: Session, org_id: str, *, now: datetime | None = None) -> None:
    """Raise `LlmBudgetExceeded` if this org is over its monthly token budget.

    A budget of `None` (the default) means unlimited -- existing orgs are
    unaffected until someone sets one.
    """
    from app.db.models import Org

    org = db.get(Org, org_id)
    if org is None or org.monthly_llm_token_budget is None:
        return
    used = org_tokens_used_this_month(db, org_id, now=now)
    if used >= org.monthly_llm_token_budget:
        raise LlmBudgetExceeded(
            f"org {org_id} has used {used} LLM tokens this month, "
            f"budget is {org.monthly_llm_token_budget}"
        )


def record_llm_call(
    *,
    context: LlmCallContext,
    model: str,
    usage: LlmUsage,
    latency_ms: int,
    ok: bool,
    error: str | None = None,
) -> None:
    """Write one `llm_call` row in its own committed transaction.

    Never raises: accounting that can break the pipeline it is measuring is
    worse than accounting that occasionally misses a row, so a failure here
    is logged and swallowed.
    """
    from app.db.base import get_sessionmaker
    from app.db.models import LlmCall

    if context.org_id is None:
        # No org context (an API-path call, or a test harness). Nothing to
        # attribute it to -- logged rather than written, so the table never
        # accumulates unattributable rows.
        log.info(
            "llm.call.unattributed",
            model=model,
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
        )
        return
    try:
        Session = get_sessionmaker()
        with Session() as db:
            db.add(
                LlmCall(
                    org_id=context.org_id,
                    capture_session_id=context.capture_session_id,
                    stage=context.stage or "",
                    model=model,
                    input_tokens=usage.input_tokens,
                    output_tokens=usage.output_tokens,
                    latency_ms=latency_ms,
                    ok=ok,
                    error=error,
                )
            )
            db.commit()
    except Exception as exc:  # pragma: no cover - defensive
        log.warning("llm.accounting_write_failed", error=str(exc))


class RecordingLlmClient:
    """`LlmClient` decorator that records every call to `llm_call`.

    Implements the same Protocol as the client it wraps, so nothing
    downstream -- agents, repair, the interface itself -- can tell the
    difference. That is the whole reason rule 4's swap point earns its
    keep here: cost accounting became a wrapper, not a cross-cutting edit.
    """

    def __init__(self, inner: LlmClient) -> None:
        self._inner = inner

    async def complete_structured(
        self,
        *,
        model: str,
        system: str,
        user_content: str,
        schema: type[T],
        max_tokens: int = 4096,
        temperature: float = 0.0,
        images: list[bytes] = [],  # noqa: B006 -- mirrors the Protocol signature
    ) -> tuple[T, LlmUsage]:
        context = current_llm_context()
        started = time.perf_counter()
        try:
            result, usage = await self._inner.complete_structured(
                model=model,
                system=system,
                user_content=user_content,
                schema=schema,
                max_tokens=max_tokens,
                temperature=temperature,
                images=images,
            )
        except Exception as exc:
            record_llm_call(
                context=context,
                model=model,
                usage=LlmUsage(model=model),
                latency_ms=int((time.perf_counter() - started) * 1000),
                ok=False,
                error=str(exc)[:500],
            )
            raise
        record_llm_call(
            context=context,
            model=model,
            usage=usage,
            latency_ms=int((time.perf_counter() - started) * 1000),
            ok=True,
        )
        return result, usage
