"""VisualSprint API entrypoint."""

from fastapi import FastAPI

from app import __version__
from app.api.upload import router as upload_router

app = FastAPI(
    title="VisualSprint",
    version=__version__,
    description="Multilingual meeting intelligence — capture, understand, verify, remember, act.",
)

app.include_router(upload_router)


@app.get("/healthz", tags=["ops"])
async def healthz() -> dict:
    return {"status": "ok", "version": __version__}
