from datetime import timedelta

import httpx
import pytest

from app.adapters.calendar_google import GoogleCalendarAdapter
from app.capture.token_provider import StaticTokenProvider
from app.db.models import CalendarConnection

EVENTS_PAGE_1 = {
    "items": [
        {
            "id": "evt-1",
            "summary": "Sprint Planning",
            "start": {"dateTime": "2026-08-03T09:00:00+05:30"},
            "end": {"dateTime": "2026-08-03T09:30:00+05:30"},
            "organizer": {"email": "nimal@acme.com", "self": True},
            "visibility": "default",
            "hangoutLink": "https://meet.google.com/abc-defg-hij",
        },
        {
            "id": "evt-2",
            "summary": "1:1 with manager",
            "start": {"dateTime": "2026-08-03T10:00:00+05:30"},
            "end": {"dateTime": "2026-08-03T10:15:00+05:30"},
            "organizer": {"email": "manager@acme.com", "self": False},
            "visibility": "private",
            "description": "",
        },
        {
            # All-day event -- date, not dateTime -- must be skipped, not crash.
            "id": "evt-3",
            "summary": "Company holiday",
            "start": {"date": "2026-08-04"},
            "end": {"date": "2026-08-05"},
        },
    ],
    "nextPageToken": "page2",
}

EVENTS_PAGE_2 = {
    "items": [
        {
            "id": "evt-4",
            "summary": "Zoom sync",
            "start": {"dateTime": "2026-08-03T14:00:00+05:30"},
            "end": {"dateTime": "2026-08-03T14:30:00+05:30"},
            "organizer": {"email": "nimal@acme.com", "self": True},
            "location": "https://acme.zoom.us/j/1234567890",
        },
    ]
}


def make_transport() -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers.get("authorization") == "Bearer test-token"
        params = dict(request.url.params)
        if "pageToken" not in params:
            return httpx.Response(200, json=EVENTS_PAGE_1)
        if params["pageToken"] == "page2":
            return httpx.Response(200, json=EVENTS_PAGE_2)
        raise AssertionError(f"unexpected request: {request.url}")

    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_lists_events_across_pages_and_skips_all_day_events():
    client = httpx.AsyncClient(transport=make_transport())
    adapter = GoogleCalendarAdapter(token_provider=StaticTokenProvider("test-token"), http_client=client)
    connection = CalendarConnection(
        org_id="org-1", provider="google", account_email="nimal@acme.com", secret_ref="ref"
    )

    events = await adapter.list_upcoming_events(connection, within=timedelta(days=1))

    ids = [e.external_event_id for e in events]
    assert ids == ["evt-1", "evt-2", "evt-4"]  # evt-3 (all-day) skipped


@pytest.mark.asyncio
async def test_parses_organizer_visibility_and_conferencing_text():
    client = httpx.AsyncClient(transport=make_transport())
    adapter = GoogleCalendarAdapter(token_provider=StaticTokenProvider("test-token"), http_client=client)
    connection = CalendarConnection(
        org_id="org-1", provider="google", account_email="nimal@acme.com", secret_ref="ref"
    )

    events = await adapter.list_upcoming_events(connection, within=timedelta(days=1))
    by_id = {e.external_event_id: e for e in events}

    sprint = by_id["evt-1"]
    assert sprint.title == "Sprint Planning"
    assert sprint.is_organizer is True
    assert sprint.visibility == "default"
    assert "meet.google.com/abc-defg-hij" in sprint.conferencing_text

    one_on_one = by_id["evt-2"]
    assert one_on_one.is_organizer is False
    assert one_on_one.visibility == "private"

    zoom_sync = by_id["evt-4"]
    assert "zoom.us/j/1234567890" in zoom_sync.conferencing_text
