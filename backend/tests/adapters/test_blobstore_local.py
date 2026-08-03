"""LocalBlobStore -- dev-mode BlobStore Protocol implementation. No test
file existed for this before; delete() in particular needs coverage since
app/orchestrator/retention.py depends on it being idempotent."""

import pytest

from app.adapters.blobstore_local import LocalBlobStore


@pytest.fixture
def store(tmp_path) -> LocalBlobStore:
    return LocalBlobStore(root=str(tmp_path))


async def test_put_then_get_roundtrips_bytes(store: LocalBlobStore):
    uri = await store.put("audio/org1/x.flac", b"fake-flac-bytes", "audio/flac")

    assert uri == "blob://audio/org1/x.flac"
    assert await store.get(uri) == b"fake-flac-bytes"


async def test_exists_true_then_false_after_delete(store: LocalBlobStore):
    uri = await store.put("keyframes/org1/frame1.jpg", b"data", "image/jpeg")
    assert await store.exists(uri) is True

    await store.delete(uri)

    assert await store.exists(uri) is False


async def test_delete_is_idempotent_on_an_already_missing_object(store: LocalBlobStore):
    # Must not raise -- see the matching S3BlobStore test for why this
    # matters to the retention sweep specifically.
    await store.delete("blob://audio/org1/never-existed.flac")


async def test_rejects_non_blob_uri(store: LocalBlobStore):
    with pytest.raises(ValueError, match="not a blob uri"):
        await store.get("https://not-a-blob-uri.example/file")


async def test_rejects_path_escape(store: LocalBlobStore):
    with pytest.raises(ValueError, match="path escape"):
        await store.get("blob://../../etc/passwd")


async def test_presigned_url_is_a_local_api_route(store: LocalBlobStore):
    uri = await store.put("audio/org1/x.flac", b"data", "audio/flac")
    url = await store.presigned_url(uri)
    assert url == "/api/v1/blobs/audio/org1/x.flac"
