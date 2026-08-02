"""CalendarAdapter swap point — discovers upcoming meetings so capture can be
scheduled without a human uploading anything (docs/PROJECT_PLAN.md Phase 1:
"Calendar watch, disclosure, coverage telemetry"). Bought today: Google
Calendar / Microsoft Graph (app/adapters/calendar_{google,microsoft}.py).

This interface returns raw calendar facts only — conferencing detection,
join-policy filtering, and Meeting/CaptureSession creation all live in
app/orchestrator/scheduler.py, not here, so an adapter never has to know
about our domain model.
"""

from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Protocol

from pydantic import BaseModel

if TYPE_CHECKING:
    from app.db.models import CalendarConnection


class CalendarEvent(BaseModel):
    external_event_id: str
    title: str
    start_at: datetime
    end_at: datetime
    organizer_email: str | None = None
    is_organizer: bool = False
    visibility: str = "default"  # "default" | "private" | "public" (Google Calendar's own values)
    # Raw text the scheduler runs conferencing-link detection over (event
    # location/description/native conferenceData) — kept as free text here
    # so calendar_common.detect_conferencing is the single place that knows
    # what a Zoom/Meet/Teams link looks like, not every adapter.
    conferencing_text: str = ""


class CalendarAdapter(Protocol):
    async def list_upcoming_events(
        self, connection: "CalendarConnection", within: timedelta
    ) -> list[CalendarEvent]:
        """Events starting between now and `within` from now, for the given
        connection's calendar. Ordering is not guaranteed; the caller sorts
        if it matters."""
        ...
