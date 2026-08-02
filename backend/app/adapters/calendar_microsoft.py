"""Microsoft Graph calendar adapter — `GET /me/calendarView`.

ASSUMPTIONS (not live-tested against the real API — field names follow the
documented Graph v1.0 event resource shape as of this writing):
- `calendarView` (not `/events`) is used because it expands recurring series
  into individual occurrences server-side, the same role Google's
  `singleEvents=true` plays — each occurrence gets its own `id`, which is
  what Meeting.external_calendar_event_id idempotency needs.
- `isOrganizer` is Graph's own boolean for "is this the signed-in user's
  event", used directly rather than comparing organizer email strings, for
  the same reliability reason as the Google adapter (see calendar_google.py).
- `sensitivity` (`normal|personal|private|confidential`) is Graph's analogue
  to Google Calendar's `visibility`; mapped to our shared "default"/"private"
  vocabulary so the scheduler's join-policy check doesn't need to know which
  provider it's looking at.
- `onlineMeeting.joinWebUrl` is included when the event has Teams meeting
  info attached natively — checked ahead of location/body text since it's a
  structured field, not something calendar_common needs to regex out of
  free text.
"""

from datetime import datetime, timedelta
from urllib.parse import urlencode

import httpx

from app.capture.token_provider import TokenProvider
from app.db.models import CalendarConnection
from app.interfaces.calendar import CalendarEvent

GRAPH_API_BASE = "https://graph.microsoft.com/v1.0"

_PRIVATE_SENSITIVITY = {"private", "confidential", "personal"}


def _parse_graph_datetime(value: str) -> datetime:
    # Graph's calendarView returns naive local-time strings alongside a
    # separate timeZone field; requesting UTC via the Prefer header (below)
    # means these arrive as UTC and can be treated as such directly.
    dt = datetime.fromisoformat(value)
    return dt.replace(tzinfo=dt.tzinfo) if dt.tzinfo else dt.astimezone()


class MicrosoftCalendarAdapter:
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
        headers = {
            "Authorization": f"Bearer {token}",
            "Prefer": 'outlook.timezone="UTC"',
        }
        now = datetime.now(tz=None).astimezone()
        params = {
            "startDateTime": now.isoformat(),
            "endDateTime": (now + within).isoformat(),
        }

        events: list[CalendarEvent] = []
        url = f"{GRAPH_API_BASE}/me/calendarView?{urlencode(params)}"
        while url:
            resp = await self._client.get(url, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            for item in data.get("value", []):
                events.append(self._parse_event(item))
            url = data.get("@odata.nextLink")
        return events

    def _parse_event(self, item: dict) -> CalendarEvent:
        organizer = item.get("organizer", {}).get("emailAddress", {})
        sensitivity = (item.get("sensitivity") or "normal").lower()
        visibility = "private" if sensitivity in _PRIVATE_SENSITIVITY else "default"

        conferencing_parts = [
            item.get("location", {}).get("displayName", ""),
            item.get("bodyPreview", ""),
        ]
        online_meeting = item.get("onlineMeeting") or {}
        join_url = online_meeting.get("joinWebUrl") or online_meeting.get("joinUrl")
        if join_url:
            conferencing_parts.append(join_url)

        return CalendarEvent(
            external_event_id=item["id"],
            title=item.get("subject", "Untitled meeting"),
            start_at=_parse_graph_datetime(item["start"]["dateTime"]),
            end_at=_parse_graph_datetime(item["end"]["dateTime"]),
            organizer_email=organizer.get("address"),
            is_organizer=bool(item.get("isOrganizer", False)),
            visibility=visibility,
            conferencing_text=" ".join(p for p in conferencing_parts if p),
        )
