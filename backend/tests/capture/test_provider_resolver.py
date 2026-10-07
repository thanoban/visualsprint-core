import httpx
import pytest

from app.capture.provider_resolver import ManagedVexaCaptureProvider, VexaProviderResolver
from app.db.models import ProviderBinding
from app.interfaces.capture_provider import CaptureStatus, MeetingTarget


class Secrets:
    def __init__(self, values):
        self.values = values

    async def get(self, name):
        if name not in self.values:
            raise KeyError(name)
        return self.values[name]


@pytest.mark.asyncio
async def test_resolver_reads_endpoint_and_key_from_tenant_secret_refs():
    resolver = VexaProviderResolver(
        Secrets({"endpoint-ref": "https://vexa.example", "key-ref": "tenant-key"})
    )
    provider = await resolver.resolve(
        ProviderBinding(
            org_id="org-1",
            provider="vexa",
            endpoint_ref="endpoint-ref",
            account_scope_id="account-1",
            secret_ref="key-ref",
        )
    )
    assert isinstance(provider, ManagedVexaCaptureProvider)


@pytest.mark.asyncio
async def test_resolver_rejects_arbitrary_or_credentialed_endpoints():
    for endpoint in (
        "http://remote.example",
        "https://user:password@vexa.example",
        "https://vexa.example/path",
    ):
        resolver = VexaProviderResolver(Secrets({"endpoint": endpoint, "key": "value"}))
        with pytest.raises(ValueError, match="endpoint_invalid"):
            await resolver.resolve(
                ProviderBinding(
                    org_id="org-1",
                    provider="vexa",
                    endpoint_ref="endpoint",
                    account_scope_id="account-1",
                    secret_ref="key",
                )
            )


@pytest.mark.asyncio
async def test_managed_provider_closes_client_and_preserves_adapter_contract(monkeypatch):
    seen = []

    async def fake_request(self, method, url, **kwargs):
        seen.append((method, str(self.base_url), self.headers["X-API-Key"]))
        return httpx.Response(
            201,
            request=httpx.Request(method, f"https://vexa.example{url}"),
            json={
                "id": "record-1",
                "platform": "google_meet",
                "native_meeting_id": "abc-defg-hij",
                "status": "requested",
            },
        )

    monkeypatch.setattr(httpx.AsyncClient, "request", fake_request)
    provider = ManagedVexaCaptureProvider("https://vexa.example", "tenant-key")
    snapshot = await provider.start(
        MeetingTarget.from_url("https://meet.google.com/abc-defg-hij")
    )
    assert snapshot.status == CaptureStatus.JOINING
    assert seen == [("POST", "https://vexa.example", "tenant-key")]
