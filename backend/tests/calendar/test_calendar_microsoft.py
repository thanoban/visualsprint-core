from datetime import timedelta

import httpx
import pytest

from app.adapters.calendar_microsoft import MicrosoftCalendarAdapter
from app.capture.token_provider import StaticTokenProvider
from app.db.models import CalendarConnection

EVENTS_PAGE_1 = {
    "value": [
        {
            "id": "evt-1",
            "subject": "Sprint Planning",
            "start": {"dateTime": "2026-08-03T09:00:00.0000000"},
            "end": {"dateTime": "2026-08-03T09:30:00.0000000"},
            "organizer": {"emailAddress": {"address": "nimal@acme.com"}},
            "isOrganizer": True,
            "sensitivity": "normal",
            "onlineMeeting": {"joinWebUrl": "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0"},
        },
        {
            "id": "evt-2",
            "subject": "Confidential review",
            "start": {"dateTime": "2026-08-03T10:00:00.0000000"},
            "end": {"dateTime": "2026-08-03T10:15:00.0000000"},
            "organizer": {"emailAddress": {"address": "manager@acme.com"}},
            "isOrganizer": False,
            "sensitivity": "confidential",
        },
    ],
    "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView?$skip=2",
}

EVENTS_PAGE_2 = {
    "value": [
        {
            "id": "evt-3",
            "subject": "Zoom sync",
            "start": {"dateTime": "2026-08-03T14:00:00.0000000"},
            "end": {"dateTime": "2026-08-03T14:30:00.0000000"},
            "organizer": {"emailAddress": {"address": "nimal@acme.com"}},
            "isOrganizer": True,
            "sensitivity": "normal",
            "location": {"displayName": "https://acme.zoom.us/j/1234567890"},
        },
    ]
}


def make_transport() -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers.get("authorization") == "Bearer test-token"
        url = str(request.url)
        if "$skip=2" in url:
            return httpx.Response(200, json=EVENTS_PAGE_2)
        if "/me/calendarView" in url:
            return httpx.Response(200, json=EVENTS_PAGE_1)
        raise AssertionError(f"unexpected request: {url}")

    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_lists_events_across_pages_via_odata_next_link():
    client = httpx.AsyncClient(transport=make_transport())
    adapter = MicrosoftCalendarAdapter(
        token_provider=StaticTokenProvider("test-token"), http_client=client
    )
    connection = CalendarConnection(
        org_id="org-1", provider="microsoft", account_email="nimal@acme.com", secret_ref="ref"
    )

    events = await adapter.list_upcoming_events(connection, within=timedelta(days=1))

    ids = [e.external_event_id for e in events]
    assert ids == ["evt-1", "evt-2", "evt-3"]


@pytest.mark.asyncio
async def test_parses_organizer_sensitivity_and_conferencing_text():
    client = httpx.AsyncClient(transport=make_transport())
    adapter = MicrosoftCalendarAdapter(
        token_provider=StaticTokenProvider("test-token"), http_client=client
    )
    connection = CalendarConnection(
        org_id="org-1", provider="microsoft", account_email="nimal@acme.com", secret_ref="ref"
    )

    events = await adapter.list_upcoming_events(connection, within=timedelta(days=1))
    by_id = {e.external_event_id: e for e in events}

    sprint = by_id["evt-1"]
    assert sprint.title == "Sprint Planning"
    assert sprint.is_organizer is True
    assert sprint.visibility == "default"
    assert "teams.microsoft.com/l/meetup-join" in sprint.conferencing_text

    confidential = by_id["evt-2"]
    assert confidential.is_organizer is False
    assert confidential.visibility == "private"  # sensitivity=confidential maps to private

    zoom_sync = by_id["evt-3"]
    assert "zoom.us/j/1234567890" in zoom_sync.conferencing_text
