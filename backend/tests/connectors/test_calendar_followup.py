"""Tests for CalendarFollowupConnector -- flagged as untested in the
component-status audit. Covers the happy path (asserting sendUpdates=none
and no attendees field, both load-bearing per the module docstring),
required-field validation, default calendar_id, and a surfaced HTTP failure.
"""

import json

import httpx
import pytest

from app.capture.token_provider import StaticTokenProvider
from app.connectors.calendar_followup import CalendarFollowupConnector
from app.connectors.errors import ConnectorError
from app.interfaces.actions import ActionKind, ActionPayload


def _client_with(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_creates_event_with_no_attendees_and_no_notifications():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/calendar/v3/calendars/primary/events"
        assert request.url.params["sendUpdates"] == "none"
        assert request.headers["authorization"] == "Bearer cal-token"
        body = json.loads(request.read())
        assert body["summary"] == "Follow-up: deploy script fix"
        assert body["start"] == {"dateTime": "2026-08-05T09:00:00+05:30"}
        assert body["end"] == {"dateTime": "2026-08-05T09:30:00+05:30"}
        # Load-bearing per module docstring: never attach attendees, even
        # though the caller could in principle supply them in `target`.
        assert "attendees" not in body
        return httpx.Response(
            200, json={"id": "evt123", "htmlLink": "https://calendar.google.com/event?eid=evt123"}
        )

    connector = CalendarFollowupConnector(
        token_provider=StaticTokenProvider("cal-token"), http_client=_client_with(handler)
    )
    payload = ActionPayload(
        kind=ActionKind.CALENDAR_FOLLOWUP,
        title="Follow-up: deploy script fix",
        body="Revisit once the Sinhala-filename bug is fixed.",
        target={"start": "2026-08-05T09:00:00+05:30", "end": "2026-08-05T09:30:00+05:30"},
    )
    result = await connector.execute(payload)

    assert result.external_id == "evt123"
    assert result.external_url == "https://calendar.google.com/event?eid=evt123"
    assert "manual follow-up" in result.detail


async def test_attendees_in_target_are_ignored_not_forwarded():
    """Even if a caller mistakenly puts attendees in target, the connector
    must not forward them -- inviting people is an intentional manual step."""

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.read())
        assert "attendees" not in body
        return httpx.Response(200, json={"id": "evt1", "htmlLink": "https://example.test"})

    connector = CalendarFollowupConnector(
        token_provider=StaticTokenProvider("t"), http_client=_client_with(handler)
    )
    payload = ActionPayload(
        kind=ActionKind.CALENDAR_FOLLOWUP,
        title="x",
        body="y",
        target={
            "start": "2026-08-05T09:00:00Z",
            "end": "2026-08-05T09:30:00Z",
            "attendees": "someone@acme.test",  # not a real supported field -- must be dropped
        },
    )
    await connector.execute(payload)


async def test_uses_primary_calendar_by_default():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/calendar/v3/calendars/primary/events"
        return httpx.Response(200, json={"id": "e1", "htmlLink": "https://example.test"})

    connector = CalendarFollowupConnector(
        token_provider=StaticTokenProvider("t"), http_client=_client_with(handler)
    )
    payload = ActionPayload(
        kind=ActionKind.CALENDAR_FOLLOWUP,
        title="x",
        body="y",
        target={"start": "2026-08-05T09:00:00Z", "end": "2026-08-05T09:30:00Z"},
    )
    await connector.execute(payload)


async def test_uses_specified_calendar_id():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/calendar/v3/calendars/team-eng@acme.test/events"
        return httpx.Response(200, json={"id": "e1", "htmlLink": "https://example.test"})

    connector = CalendarFollowupConnector(
        token_provider=StaticTokenProvider("t"), http_client=_client_with(handler)
    )
    payload = ActionPayload(
        kind=ActionKind.CALENDAR_FOLLOWUP,
        title="x",
        body="y",
        target={
            "start": "2026-08-05T09:00:00Z",
            "end": "2026-08-05T09:30:00Z",
            "calendar_id": "team-eng@acme.test",
        },
    )
    await connector.execute(payload)


async def test_requires_start_and_end():
    connector = CalendarFollowupConnector(
        token_provider=StaticTokenProvider("t"), http_client=_client_with(lambda r: httpx.Response(200))
    )
    payload = ActionPayload(kind=ActionKind.CALENDAR_FOLLOWUP, title="x", body="y", target={})
    with pytest.raises(ConnectorError, match="requires 'start' and 'end'"):
        await connector.execute(payload)


async def test_surfaces_http_failure_not_a_silent_success():
    connector = CalendarFollowupConnector(
        token_provider=StaticTokenProvider("t"),
        http_client=_client_with(lambda r: httpx.Response(400, text="invalid datetime")),
    )
    payload = ActionPayload(
        kind=ActionKind.CALENDAR_FOLLOWUP,
        title="x",
        body="y",
        target={"start": "not-a-date", "end": "also-not-a-date"},
    )
    with pytest.raises(ConnectorError, match="400"):
        await connector.execute(payload)
