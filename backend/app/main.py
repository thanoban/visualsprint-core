"""VisualSprint API entrypoint."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api.actions import router as actions_router
from app.api.chat import router as chat_router
from app.api.corrections import router as corrections_router
from app.api.data_rights import router as data_rights_router
from app.api.report import router as report_router
from app.api.rtms_webhook import router as rtms_webhook_router
from app.api.upload import router as upload_router
from app.config import get_settings

app = FastAPI(
    title="VisualSprint",
    version=__version__,
    description="Multilingual meeting intelligence — capture, understand, verify, remember, act.",
)

# The frontend (Next.js, its own origin) calls this API directly from the
# browser -- without this, every fetch from app/**/page.tsx is blocked by the
# browser's CORS check before it ever reaches a route handler, surfacing as
# an opaque "Failed to fetch" with no server-side error to debug.
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(upload_router)
app.include_router(report_router)
app.include_router(chat_router)
app.include_router(corrections_router)
app.include_router(actions_router)
app.include_router(data_rights_router)
app.include_router(rtms_webhook_router)


@app.get("/healthz", tags=["ops"])
async def healthz() -> dict:
    return {"status": "ok", "version": __version__}
