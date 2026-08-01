"""Happy-path + failure-path tests for EmailDraftConnector and
ChannelRecapConnector against a mocked httpx transport -- no real
Gmail/Slack credentials needed.
"""

import httpx
import pytest

from app.capture.token_provider import StaticTokenProvider
from app.connectors.channel_recap import ChannelRecapConnector
from app.connectors.email_draft import EmailDraftConnector
from app.connectors.errors import ConnectorError
from app.interfaces.actions import ActionKind, ActionPayload


def _client_with(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_email_draft_creates_gmail_draft_never_sends():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/gmail/v1/users/me/drafts"
        assert "send" not in str(request.url)
        return httpx.Response(200, json={"id": "draft123", "message": {"id": "msg456"}})

    connector = EmailDraftConnector(
        token_provider=StaticTokenProvider("fake-token"), http_client=_client_with(handler)
    )
    payload = ActionPayload(
        kind=ActionKind.EMAIL_DRAFT, title="Follow-up: standup", body="Notes...", target={"to": "team@acme.test"}
    )
    result = await connector.execute(payload)

    assert result.external_id == "draft123"
    assert "drafts?compose=msg456" in result.external_url


async def test_email_draft_requires_a_recipient():
    connector = EmailDraftConnector(
        token_provider=StaticTokenProvider("fake-token"), http_client=_client_with(lambda r: httpx.Response(200))
    )
    payload = ActionPayload(kind=ActionKind.EMAIL_DRAFT, title="x", body="y", target={})
    with pytest.raises(ConnectorError, match="requires 'to'"):
        await connector.execute(payload)


async def test_email_draft_surfaces_gmail_error_not_a_silent_success():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="invalid credentials")

    connector = EmailDraftConnector(token_provider=StaticTokenProvider("bad"), http_client=_client_with(handler))
    payload = ActionPayload(kind=ActionKind.EMAIL_DRAFT, title="x", body="y", target={"to": "a@b.test"})
    with pytest.raises(ConnectorError, match="401"):
        await connector.execute(payload)


async def test_channel_recap_posts_to_slack_webhook():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == httpx.URL("https://hooks.slack.test/x")
        body = request.read()
        assert b"Decision recap" in body
        return httpx.Response(200, text="ok")

    connector = ChannelRecapConnector(http_client=_client_with(handler))
    payload = ActionPayload(
        kind=ActionKind.CHANNEL_RECAP, title="Decision recap", body="We chose Postgres.",
        target={"provider": "slack", "webhook_url": "https://hooks.slack.test/x"},
    )
    result = await connector.execute(payload)
    assert "Slack" in result.detail


async def test_channel_recap_rejects_unknown_provider():
    connector = ChannelRecapConnector(http_client=_client_with(lambda r: httpx.Response(200)))
    payload = ActionPayload(kind=ActionKind.CHANNEL_RECAP, title="x", body="y", target={"provider": "discord"})
    with pytest.raises(ConnectorError, match="unsupported channel_recap provider"):
        await connector.execute(payload)
