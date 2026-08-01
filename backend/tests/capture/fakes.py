"""Shared test doubles for capture adapter tests."""


class InMemoryBlobStore:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.content_types: dict[str, str] = {}

    async def put(
        self, key: str, data: bytes, content_type: str = "application/octet-stream"
    ) -> str:
        uri = f"blob://{key}"
        self.objects[uri] = data
        self.content_types[uri] = content_type
        return uri

    async def get(self, uri: str) -> bytes:
        return self.objects[uri]

    async def exists(self, uri: str) -> bool:
        return uri in self.objects

    async def presigned_url(self, uri: str, expires_s: int = 3600) -> str:
        return uri
