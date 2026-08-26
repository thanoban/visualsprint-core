"""Instant-meeting capture -- join a meeting that was never on a calendar.

Calendar sync (app/orchestrator/scheduler.py) only ever sees meetings that
exist as calendar events ahead of time. A meeting started ad hoc ("hop on a
call now") has no such event, so it needs its own trigger. Zoom doesn't need
one at all: RTMS (Mode A1, app/api/rtms_webhook.py) is tied to the host's
Zoom account, not a calendar entry, so it already fires for every meeting
that account starts, scheduled or not. Meet/Teams have no equivalent
account-level hook, so this is the paste-a-link path the plan calls
"Capture now" -- it creates the same BotSession row the scheduler would have
created from a calendar event, just with scheduled_start=now instead of a
future time.
"""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.adapters.calendar_common import BOT_ELIGIBLE_PLATFORMS, bot_join_url, detect_conferencing
from app.auth.dependency import require_org_member
from app.config import get_settings
from app.db.base import get_db
from app.db.models import BotSession, BotStatus, Meeting

router = APIRouter(prefix="/api/v1/orgs/{org_id}/capture", tags=["capture"])


class InstantCaptureRequest(BaseModel):
    url: str
    title: str = ""


class InstantCaptureResponse(BaseModel):
    platform: str
    dispatched: bool
    meeting_id: str | None = None
    bot_session_id: str | None = None
    note: str
    admission_guidance: str | None = None


def _admission_guidance(
    platform: str, bot_google_account_email: str | None, google_join_mode: str
) -> str | None:
    if platform == "meet":
        if google_join_mode.strip().lower() != "session":
            return (
                "Use a Google Workspace Meet that permits guest participants: invite the "
                "VisualSprint bot account or allow guests/everyone with the link. This "
                "durable mode does not use a Google browser login. For private personal "
                "Gmail meetings, use the official recording/transcript capture path. "
                "The bot cannot bypass host controls."
            )
        account = (
            f"Invite {bot_google_account_email} to the calendar event"
            if bot_google_account_email
            else "Invite the dedicated VisualSprint bot Google account to the calendar event"
        )
        return (
            f"{account}, then set Google Meet access to allow that account (or allow everyone "
            "with the link). This avoids a lobby request. The bot cannot bypass host controls."
        )
    if platform == "teams":
        return (
            "Set the Teams lobby policy to allow the bot, or add it as an allowed participant "
            "before the meeting starts. The bot cannot bypass organizer admission."
        )
    return None


class BotSessionStatusResponse(BaseModel):
    id: str
    status: str
    platform: str
    scheduled_start: datetime | None = None
    joined_at: datetime | None = None
    ended_at: datetime | None = None
    lobby_timeout_at: datetime | None = None
    error: str | None = None
    capture_session_id: str | None = None


@router.post("/instant", response_model=InstantCaptureResponse)
async def start_instant_capture(
    org_id: str,
    body: InstantCaptureRequest,
    db: Session = Depends(get_db),
    _: None = Depends(require_org_member),
) -> InstantCaptureResponse:
    conferencing = detect_conferencing(body.url)
    if conferencing is None:
        raise HTTPException(
            422, "couldn't recognize a Zoom, Google Meet, or Microsoft Teams link in that URL"
        )
    platform, platform_meeting_id = conferencing

    if platform == "zoom":
        # No BotSession to create: RTMS is tied to the host's Zoom account
        # (app/api/rtms_webhook.py), not to this endpoint or a calendar
        # entry, so it already captures this meeting automatically once it
        # starts -- provided the org has connected Zoom and RTMS is enabled
        # on the account. Nothing for this endpoint to dispatch.
        return InstantCaptureResponse(
            platform=platform,
            dispatched=False,
            note=(
                "Zoom meetings are captured automatically via RTMS as soon as they start "
                "on a connected host account -- no manual join needed."
            ),
        )

    if platform not in BOT_ELIGIBLE_PLATFORMS:
        raise HTTPException(422, f"instant capture isn't supported for platform {platform!r}")

    join_url = bot_join_url(platform, platform_meeting_id)
    if join_url is None:
        raise HTTPException(422, f"couldn't build a join URL for platform {platform!r}")

    now = datetime.now(UTC)
    meeting = Meeting(
        org_id=org_id,
        title=body.title or "Instant meeting",
        platform=platform,
        platform_meeting_id=platform_meeting_id,
        scheduled_start=now,
    )
    db.add(meeting)
    db.flush()

    bot = BotSession(
        org_id=org_id,
        meeting_id=meeting.id,
        platform=platform,
        join_url=join_url,
        status=BotStatus.SCHEDULED,
        scheduled_start=now,
    )
    db.add(bot)
    db.commit()

    settings = get_settings()
    note = (
        'Bot queued as "VisualSprint Notetaker" — will join within ~2 minutes.'
        if settings.bot_dispatch_enabled
        else (
            "Bot capture is queued but not yet dispatched — live bot join isn't turned on "
            "for this deployment yet."
        )
    )
    return InstantCaptureResponse(
        platform=platform,
        dispatched=settings.bot_dispatch_enabled,
        meeting_id=meeting.id,
        bot_session_id=bot.id,
        note=note,
        admission_guidance=_admission_guidance(
            platform, settings.bot_google_account_email, settings.bot_google_join_mode
        ),
    )


@router.get("/sessions/{bot_session_id}", response_model=BotSessionStatusResponse)
async def get_bot_session_status(
    org_id: str,
    bot_session_id: str,
    db: Session = Depends(get_db),
    _: None = Depends(require_org_member),
) -> BotSessionStatusResponse:
    """Poll the live status of one bot session created by POST /instant."""
    bot = db.get(BotSession, bot_session_id)
    if bot is None or bot.org_id != org_id:
        raise HTTPException(404, "bot session not found")
    return BotSessionStatusResponse(
        id=bot.id,
        status=bot.status.value,
        platform=bot.platform,
        scheduled_start=bot.scheduled_start,
        joined_at=bot.joined_at,
        ended_at=bot.ended_at,
        lobby_timeout_at=bot.lobby_timeout_at,
        error=bot.error,
        capture_session_id=bot.capture_session_id,
    )
