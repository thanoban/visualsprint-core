"""Structured-logging configuration and request correlation.

structlog was already used consistently across the codebase, but nothing tied
a log line to the thing it was about: a request, a capture session, a job.
Tracing one meeting's failure across API -> queue -> worker -> agent meant
grepping by timestamp and hoping.

`configure_logging()` installs `merge_contextvars` explicitly rather than
relying on structlog's defaults, so anything bound with
`structlog.contextvars.bind_contextvars` -- the request id here, the
job/stage/session in `app.orchestrator.worker.run_once` -- appears on every
subsequent line from that request or job without being passed down by hand.

Also here: a deliberately small per-instance rate limiter. It is not a
distributed quota (each Cloud Run container keeps its own counters); it is a
blunt guard so one client cannot hammer a single container's upload or
webhook endpoint. Stated plainly rather than implied, because a rate limit
that people believe is global when it isn't is worse than none.
"""

from __future__ import annotations

import time
import uuid
from collections import defaultdict, deque

import structlog
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp

from app.config import get_settings

REQUEST_ID_HEADER = "X-Request-ID"


def configure_logging() -> None:
    """Idempotent structlog setup. Safe to call from both API and worker."""
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.dev.ConsoleRenderer()
            if get_settings().env == "dev"
            else structlog.processors.JSONRenderer(),
        ],
        cache_logger_on_first_use=True,
    )


class RequestContextMiddleware(BaseHTTPMiddleware):
    """Bind a request id (and route) to the logging context for the request.

    Honours an inbound `X-Request-ID` so a trace started by a load balancer
    or the frontend carries through, and echoes it on the response so a user
    reporting a problem can quote one id that finds every related log line.
    """

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        request_id = request.headers.get(REQUEST_ID_HEADER) or str(uuid.uuid4())
        tokens = structlog.contextvars.bind_contextvars(
            request_id=request_id,
            path=request.url.path,
            method=request.method,
        )
        request.state.request_id = request_id
        try:
            response = await call_next(request)
        finally:
            structlog.contextvars.reset_contextvars(**tokens)
        response.headers[REQUEST_ID_HEADER] = request_id
        return response


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Fixed-window-ish token bucket over a sliding window, per client IP.

    Applied only to the routes that are expensive or unauthenticated -- the
    upload endpoint and the Zoom webhook. Everything else is untouched: this
    is a targeted guard, not a global throttle.

    In-process state, so the limit is per container instance. With N
    instances the effective ceiling is N x the configured rate. That is
    acceptable for what this defends against (one client hammering one
    container) and inadequate for billing-grade quotas, which would need
    shared state.
    """

    def __init__(self, app: ASGIApp, limits: dict[str, int] | None = None) -> None:
        super().__init__(app)
        settings = get_settings()
        self._window_s = settings.rate_limit_window_s
        self._limits = limits or {
            "/api/v1/meetings/upload": settings.rate_limit_upload_per_window,
            "/api/v1/webhooks/zoom/rtms": settings.rate_limit_webhook_per_window,
        }
        self._hits: dict[tuple[str, str], deque[float]] = defaultdict(deque)

    def _limit_for(self, path: str) -> int | None:
        return self._limits.get(path)

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        limit = self._limit_for(request.url.path)
        if not limit:
            return await call_next(request)

        client = request.client.host if request.client else "unknown"
        now = time.monotonic()
        hits = self._hits[(client, request.url.path)]
        cutoff = now - self._window_s
        while hits and hits[0] < cutoff:
            hits.popleft()
        if len(hits) >= limit:
            retry_after = max(1, int(self._window_s - (now - hits[0])))
            return JSONResponse(
                {"detail": "rate limit exceeded"},
                status_code=429,
                headers={"Retry-After": str(retry_after)},
            )
        hits.append(now)
        return await call_next(request)
