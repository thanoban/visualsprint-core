"""VisualSprint API entrypoint."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api.actions import router as actions_router
from app.api.capture import router as capture_router
from app.api.chat import router as chat_router
from app.api.companion import router as companion_router
from app.api.corrections import router as corrections_router
from app.api.data_rights import router as data_rights_router
from app.api.leads import router as leads_router
from app.api.me import router as me_router
from app.api.meetings import router as meetings_router
from app.api.oauth import router as oauth_router
from app.api.ops import router as ops_router
from app.api.people import router as people_router
from app.api.report import router as report_router
from app.api.rtms_webhook import router as rtms_webhook_router
from app.api.rtms_webhook import set_websocket_connector
from app.api.speakers import router as speakers_router
from app.api.upload import router as upload_router
from app.config import get_settings
from app.observability import (
    RateLimitMiddleware,
    RequestContextMiddleware,
    configure_logging,
)

configure_logging()


@asynccontextmanager
async def _lifespan(app: FastAPI):
    from app.api.rtms_webhook import _connector
    from app.capture.rtms_ws_connector import WebsocketsConnector

    installed = _connector is None
    if installed:
        set_websocket_connector(WebsocketsConnector())
    yield
    if installed:
        set_websocket_connector(None)


app = FastAPI(
    lifespan=_lifespan,
    title="VisualSprint",
    version=__version__,
    description="Multilingual meeting intelligence — capture, understand, verify, remember, act.",
)

# The frontend (Next.js, its own origin) calls this API directly from the
# browser -- without this, every fetch from app/**/page.tsx is blocked by the
# browser's CORS check before it ever reaches a route handler, surfacing as
# an opaque "Failed to fetch" with no server-side error to debug.
_cors_origins = list(get_settings().cors_allowed_origins)
if get_settings().companion_extension_id:
    _cors_origins.append(f"chrome-extension://{get_settings().companion_extension_id}")

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Middleware runs in reverse registration order, so the rate limiter is
# registered after the context middleware so a rejected request is still
# logged with its request id.
if get_settings().rate_limit_enabled:
    app.add_middleware(RateLimitMiddleware)
app.add_middleware(RequestContextMiddleware)

app.include_router(upload_router)
app.include_router(meetings_router)
app.include_router(capture_router)
app.include_router(report_router)
app.include_router(chat_router)
app.include_router(corrections_router)
app.include_router(actions_router)
app.include_router(data_rights_router)
app.include_router(rtms_webhook_router)
app.include_router(oauth_router)
app.include_router(me_router)
app.include_router(people_router)
app.include_router(speakers_router)
app.include_router(ops_router)
app.include_router(leads_router)
app.include_router(companion_router)


@app.get("/healthz", tags=["ops"])
async def healthz() -> dict:
    return {"status": "ok", "version": __version__}
