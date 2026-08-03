"""S3BlobStore against a fake botocore-shaped client -- no real botocore
import needed to run these (same pattern as PaddleOCR/pyannote tests: the
lazy import only fires if no client is injected)."""

import io

import pytest

from app.adapters.blobstore_s3 import S3BlobStore


class FakeClientError(Exception):
    """Mimics botocore.exceptions.ClientError's `.response["Error"]["Code"]` shape."""

    def __init__(self, code: str) -> None:
        self.response = {"Error": {"Code": code}}
        super().__init__(code)


class FakeStreamingBody:
    def __init__(self, data: bytes) -> None:
        self._buf = io.BytesIO(data)

    def read(self) -> bytes:
        return self._buf.read()


class FakeS3Client:
    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], tuple[bytes, str]] = {}
        self.put_calls: list[dict] = []

    def put_object(self, *, Bucket, Key, Body, ContentType):
        self.put_calls.append({"Bucket": Bucket, "Key": Key, "ContentType": ContentType})
        self.objects[(Bucket, Key)] = (Body, ContentType)

    def get_object(self, *, Bucket, Key):
        if (Bucket, Key) not in self.objects:
            raise FakeClientError("NoSuchKey")
        data, _content_type = self.objects[(Bucket, Key)]
        return {"Body": FakeStreamingBody(data)}

    def delete_object(self, *, Bucket, Key):
        # Real S3 delete_object is idempotent -- succeeds whether or not the
        # key exists, so this fake must too (no FakeClientError here).
        self.objects.pop((Bucket, Key), None)

    def head_object(self, *, Bucket, Key):
        if (Bucket, Key) not in self.objects:
            raise FakeClientError("404")
        return {}

    def generate_presigned_url(self, operation, Params, ExpiresIn):
        return f"https://fake-r2.example/{Params['Bucket']}/{Params['Key']}?expires={ExpiresIn}"


@pytest.fixture
def client() -> FakeS3Client:
    return FakeS3Client()


@pytest.fixture
def store(client: FakeS3Client) -> S3BlobStore:
    return S3BlobStore(client=client, bucket="test-bucket")


async def test_put_stores_object_and_returns_blob_uri(store: S3BlobStore, client: FakeS3Client):
    uri = await store.put("audio/org1/session1.flac", b"fake-flac-bytes", "audio/flac")

    assert uri == "blob://audio/org1/session1.flac"
    assert client.objects[("test-bucket", "audio/org1/session1.flac")] == (
        b"fake-flac-bytes",
        "audio/flac",
    )
    assert client.put_calls[0]["ContentType"] == "audio/flac"


async def test_get_retrieves_previously_put_bytes(store: S3BlobStore):
    uri = await store.put("keyframes/org1/frame1.jpg", b"fake-jpeg-bytes", "image/jpeg")

    data = await store.get(uri)

    assert data == b"fake-jpeg-bytes"


async def test_get_rejects_non_blob_uri(store: S3BlobStore):
    with pytest.raises(ValueError, match="not a blob uri"):
        await store.get("https://not-a-blob-uri.example/file")


async def test_exists_true_for_stored_object(store: S3BlobStore):
    uri = await store.put("audio/org1/x.flac", b"data", "audio/flac")
    assert await store.exists(uri) is True


async def test_exists_false_for_missing_object_maps_404_to_false(store: S3BlobStore):
    assert await store.exists("blob://audio/org1/never-uploaded.flac") is False


async def test_exists_does_not_swallow_non_404_errors(store: S3BlobStore, client: FakeS3Client):
    """A real outage (auth failure, network error, wrong bucket) must
    surface as an error -- silently reporting it as "doesn't exist" would
    misrepresent an infrastructure failure as a missing blob."""

    def raise_auth_error(*, Bucket, Key):
        raise FakeClientError("AccessDenied")

    client.head_object = raise_auth_error

    with pytest.raises(FakeClientError, match="AccessDenied"):
        await store.exists("blob://audio/org1/x.flac")


async def test_presigned_url_includes_bucket_key_and_expiry(store: S3BlobStore):
    uri = await store.put("keyframes/org1/frame1.jpg", b"data", "image/jpeg")

    url = await store.presigned_url(uri, expires_s=900)

    assert url == "https://fake-r2.example/test-bucket/keyframes/org1/frame1.jpg?expires=900"


async def test_delete_removes_the_object(store: S3BlobStore, client: FakeS3Client):
    uri = await store.put("audio/org1/x.flac", b"data", "audio/flac")
    assert await store.exists(uri) is True

    await store.delete(uri)

    assert await store.exists(uri) is False


async def test_delete_is_idempotent_on_an_already_missing_object(store: S3BlobStore):
    # Must not raise -- retention sweeps can legitimately try to delete a
    # blob twice (e.g. a crash-and-retry), and S3's own delete_object is
    # spec'd as idempotent, so this adapter must not add a 404 error on top.
    await store.delete("blob://audio/org1/never-existed.flac")


async def test_requires_endpoint_url_when_no_client_injected(monkeypatch):
    from app.config import get_settings

    get_settings.cache_clear()
    monkeypatch.setenv("VS_BLOB_BACKEND", "s3")
    monkeypatch.delenv("VS_S3_ENDPOINT_URL", raising=False)
    try:
        with pytest.raises(RuntimeError, match="VS_S3_ENDPOINT_URL"):
            S3BlobStore()
    finally:
        get_settings.cache_clear()
