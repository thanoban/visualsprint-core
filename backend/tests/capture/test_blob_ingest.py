import httpx
import pytest

from app.capture.blob_ingest import download_and_store
from tests.capture.fakes import InMemoryBlobStore


@pytest.mark.asyncio
async def test_download_and_store_falls_back_without_ffmpeg():
    """This dev/CI environment has no ffmpeg on PATH, so the untranscoded fallback
    path must store the raw bytes under the source extension rather than dropping
    them or raising."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers.get("x-test") == "1"
        return httpx.Response(200, content=b"raw-audio-bytes")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    blob_store = InMemoryBlobStore()

    uri = await download_and_store(
        source_url="https://example.com/audio.m4a",
        blob_store=blob_store,
        blob_key="some/key",
        http_client=client,
        source_suffix=".m4a",
        extra_headers={"x-test": "1"},
    )

    assert uri == "blob://some/key.m4a"
    assert blob_store.objects[uri] == b"raw-audio-bytes"
    assert blob_store.content_types[uri] == "application/octet-stream"
