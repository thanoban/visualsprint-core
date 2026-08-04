"""EscalationConnector and ReminderConnector delegate to
ChannelRecapConnector / EmailDraftConnector respectively -- these tests
prove the delegation actually wires through (correct `kind`, payload
reaches the real HTTP call, errors propagate unmodified), not that Slack/
Gmail behavior itself is correct (that's covered by test_email_and_channel.py).
"""

import httpx
import pytest

from app.capture.token_provider import StaticTokenProvider
from app.connectors.errors import ConnectorError
from app.connectors.escalation import EscalationConnector
from app.connectors.reminder import ReminderConnector
from app.interfaces.actions import ActionKind, ActionPayload


def _client_with(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_escalation_connector_declares_its_kind():
    assert EscalationConnector().kind == ActionKind.ESCALATION


def test_reminder_connector_declares_its_kind():
    assert ReminderConnector(token_provider=StaticTokenProvider("x")).kind == ActionKind.REMINDER


async def test_escalation_posts_to_slack_webhook_via_channel_recap():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == httpx.URL("https://hooks.slack.test/escalate")
        assert b"RECURRING blocker" in request.read()
        return httpx.Response(200, text="ok")

    connector = EscalationConnector(http_client=_client_with(handler))
    payload = ActionPayload(
        kind=ActionKind.ESCALATION,
        title="RECURRING blocker",
        body="Same blocker has recurred across 3 meetings.",
        target={"provider": "slack", "webhook_url": "https://hooks.slack.test/escalate"},
    )
    result = await connector.execute(payload)
    assert "Slack" in result.detail


async def test_escalation_propagates_channel_recap_errors():
    connector = EscalationConnector(http_client=_client_with(lambda r: httpx.Response(200)))
    payload = ActionPayload(
        kind=ActionKind.ESCALATION, title="x", body="y", target={"provider": "discord"}
    )
    with pytest.raises(ConnectorError, match="unsupported channel_recap provider"):
        await connector.execute(payload)


async def test_reminder_creates_a_gmail_draft_via_email_draft():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/gmail/v1/users/me/drafts"
        return httpx.Response(200, json={"id": "draft789", "message": {"id": "msg999"}})

    connector = ReminderConnector(
        token_provider=StaticTokenProvider("fake-token"), http_client=_client_with(handler)
    )
    payload = ActionPayload(
        kind=ActionKind.REMINDER,
        title="Reminder: migration plan due",
        body="Your commitment is due tomorrow.",
        target={"to": "owner@acme.test"},
    )
    result = await connector.execute(payload)
    assert result.external_id == "draft789"


async def test_reminder_propagates_email_draft_errors():
    connector = ReminderConnector(
        token_provider=StaticTokenProvider("x"),
        http_client=_client_with(lambda r: httpx.Response(200)),
    )
    payload = ActionPayload(kind=ActionKind.REMINDER, title="x", body="y", target={})
    with pytest.raises(ConnectorError, match="requires 'to'"):
        await connector.execute(payload)
