"""VisualSprint API entrypoint."""

from fastapi import FastAPI

from app import __version__
from app.api.chat import router as chat_router
from app.api.report import router as report_router
from app.api.upload import router as upload_router

app = FastAPI(
    title="VisualSprint",
    version=__version__,
    description="Multilingual meeting intelligence — capture, understand, verify, remember, act.",
)

app.include_router(upload_router)
app.include_router(report_router)
app.include_router(chat_router)


@app.get("/healthz", tags=["ops"])
async def healthz() -> dict:
    return {"status": "ok", "version": __version__}
