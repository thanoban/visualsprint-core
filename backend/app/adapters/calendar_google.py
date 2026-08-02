"""Google Calendar adapter — Calendar API v3 `events.list`.

ASSUMPTIONS (not live-tested against the real API — field names follow the
documented Calendar API v3 event resource shape as of this writing):
- `connection.account_email` names the calendar to read; we use `primary`
  when it's the connected account's own calendar, which is the only case
  this MVP needs (docs/PROJECT_PLAN.md's join-policy model is per-org, not
  per-delegate-calendar).
- `organizer.self` on an event is Google's own "is this the connected
  account's event" flag — used directly as CalendarEvent.is_organizer rather
  than comparing organizer email strings, which is what the API itself
  recommends over email comparison (aliases/groups make email comparison
  unreliable).
- Recurring events are expanded via `singleEvents=true`, so each occurrence
  arrives as its own event with its own `id` — exactly what
  Meeting.external_calendar_event_id idempotency needs.
"""

from datetime import datetime, timedelta

import httpx

from app.capture.token_provider import TokenProvider
from app.db.models import CalendarConnection
from app.interfaces.calendar import CalendarEvent

CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3"


def _parse_rfc3339(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


class GoogleCalendarAdapter:
    def __init__(
        self,
        *,
        token_provider: TokenProvider,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._tokens = token_provider
        self._client = http_client or httpx.AsyncClient()

    async def list_upcoming_events(
        self, connection: CalendarConnection, within: timedelta
    ) -> list[CalendarEvent]:
        token = await self._tokens.get_token()
        headers = {"Authorization": f"Bearer {token}"}
        now = datetime.now(tz=None).astimezone()
        params = {
            "timeMin": now.isoformat(),
            "timeMax": (now + within).isoformat(),
            "singleEvents": "true",
            "orderBy": "startTime",
        }

        events: list[CalendarEvent] = []
        page_token: str | None = None
        while True:
            if page_token:
                params["pageToken"] = page_token
            resp = await self._client.get(
                f"{CALENDAR_API_BASE}/calendars/primary/events", headers=headers, params=params
            )
            resp.raise_for_status()
            data = resp.json()
            for item in data.get("items", []):
                event = self._parse_event(item)
                if event is not None:
                    events.append(event)
            page_token = data.get("nextPageToken")
            if not page_token:
                break
        return events

    def _parse_event(self, item: dict) -> CalendarEvent | None:
        start = item.get("start", {}).get("dateTime")
        end = item.get("end", {}).get("dateTime")
        if not start or not end:
            return None  # all-day event (date, not dateTime) -- not a meeting to capture

        organizer = item.get("organizer", {})
        conferencing_parts = [
            item.get("location", ""),
            item.get("description", ""),
            item.get("hangoutLink", ""),
        ]
        for entry_point in item.get("conferenceData", {}).get("entryPoints", []):
            uri = entry_point.get("uri")
            if uri:
                conferencing_parts.append(uri)

        return CalendarEvent(
            external_event_id=item["id"],
            title=item.get("summary", "Untitled meeting"),
            start_at=_parse_rfc3339(start),
            end_at=_parse_rfc3339(end),
            organizer_email=organizer.get("email"),
            is_organizer=bool(organizer.get("self", False)),
            visibility=item.get("visibility", "default"),
            conferencing_text=" ".join(p for p in conferencing_parts if p),
        )
