"""Tenant-scoped capture provider resolution."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

import httpx

from app.adapters.capture_vexa import VexaCaptureProvider
from app.db.models import ProviderBinding
from app.interfaces.capture_provider import (
    CaptureProvider,
    CaptureReference,
    CaptureSnapshot,
    MeetingTarget,
    TranscriptSnapshot,
)
from app.interfaces.secretstore import SecretStore


def validate_provider_base_url(value: str) -> str:
    parsed = urlsplit(value)
    loopback = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if (
        not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in ("", "/")
        or (parsed.scheme != "https" and not (parsed.scheme == "http" and loopback))
    ):
        raise ValueError("capture_provider_endpoint_invalid")
    return value.rstrip("/")


class ManagedVexaCaptureProvider(CaptureProvider):
    """Creates and closes one HTTP client per operation."""

    def __init__(self, base_url: str, api_key: str, *, timeout_seconds: float = 15):
        self._base_url = validate_provider_base_url(base_url)
        if not api_key.strip():
            raise ValueError("capture_provider_key_missing")
        self._api_key = api_key
        self._timeout = timeout_seconds

    @asynccontextmanager
    async def _provider(self) -> AsyncIterator[VexaCaptureProvider]:
        async with httpx.AsyncClient(
            base_url=self._base_url,
            headers={"X-API-Key": self._api_key},
            timeout=self._timeout,
            follow_redirects=False,
        ) as client:
            yield VexaCaptureProvider(client)

    async def start(self, target: MeetingTarget) -> CaptureSnapshot:
        async with self._provider() as provider:
            return await provider.start(target)

    async def status(self, reference: CaptureReference) -> CaptureSnapshot:
        async with self._provider() as provider:
            return await provider.status(reference)

    async def transcript(self, reference: CaptureReference) -> TranscriptSnapshot:
        async with self._provider() as provider:
            return await provider.transcript(reference)

    async def stop(self, reference: CaptureReference) -> None:
        async with self._provider() as provider:
            await provider.stop(reference)

    async def delete_artifacts(self, reference: CaptureReference) -> None:
        async with self._provider() as provider:
            await provider.delete_artifacts(reference)


class VexaProviderResolver:
    def __init__(self, secret_store: SecretStore):
        self._secret_store = secret_store

    async def resolve(self, binding: ProviderBinding) -> CaptureProvider:
        if binding.provider != "vexa":
            raise ValueError("unsupported_capture_provider")
        base_url = await self._secret_store.get(binding.endpoint_ref)
        api_key = await self._secret_store.get(binding.secret_ref)
        return ManagedVexaCaptureProvider(base_url, api_key)
