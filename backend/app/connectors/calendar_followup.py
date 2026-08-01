"""Google Calendar follow-up connector — ActionKind.CALENDAR_FOLLOWUP.

Creates the event with `sendUpdates=none` so the Calendar API never emails
anyone on our behalf. Google Calendar events have no true "draft" state once
created (unlike Gmail drafts), so as a substitute we deliberately never
attach `attendees` even if the caller supplied them in `target` — inviting
people is left as an explicit manual step for a human reviewer. This
limitation is intentional, not an oversight.

`target` fields used: "calendar_id" (default "primary"), "start", "end"
(RFC3339 datetimes, required).
"""

import httpx

from app.capture.token_provider import TokenProvider
from app.connectors.errors import ConnectorError
from app.interfaces.actions import ActionKind, ActionPayload, ActionResult

CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3"


class CalendarFollowupConnector:
    kind = ActionKind.CALENDAR_FOLLOWUP

    def __init__(
        self,
        *,
        token_provider: TokenProvider,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._tokens = token_provider
        self._client = http_client or httpx.AsyncClient()

    async def execute(self, payload: ActionPayload) -> ActionResult:
        start = payload.target.get("start")
        end = payload.target.get("end")
        if not start or not end:
            raise ConnectorError("calendar_followup target requires 'start' and 'end'")
        calendar_id = payload.target.get("calendar_id", "primary")

        token = await self._tokens.get_token()
        resp = await self._client.post(
            f"{CALENDAR_API_BASE}/calendars/{calendar_id}/events",
            params={"sendUpdates": "none"},
            headers={"Authorization": f"Bearer {token}"},
            json={
                "summary": payload.title,
                "description": payload.body,
                "start": {"dateTime": start},
                "end": {"dateTime": end},
                # No attendees added — see module docstring.
            },
        )
        if resp.status_code >= 400:
            raise ConnectorError(
                f"Calendar event creation failed ({resp.status_code}): {resp.text}"
            )
        data = resp.json()
        return ActionResult(
            external_id=data.get("id"),
            external_url=data.get("htmlLink"),
            detail="Calendar event created with no attendees; inviting is a manual follow-up step",
        )
