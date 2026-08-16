"""MeetingJoiner swap point (docs/03-capture.md Mode B) -- one interface per
platform's guest-bot join mechanics (Meet, Teams, Zoom-web fallback), so
app/bot/runner.py orchestrates a single join/capture/leave lifecycle without
knowing which platform it's talking to.

Deliberately narrow: a joiner's only job is getting into the room, watching
the roster, and reporting whether it is still there. Audio/screen capture
are separate swap points (BotAudioCapture / BotScreenCapture below) because
they operate on the same underlying browser page regardless of platform --
the Web Audio API injection and screenshot loop don't change per vendor,
only the join/lobby/roster mechanics do.
"""

from collections.abc import AsyncIterator
from enum import StrEnum
from typing import Protocol

from pydantic import BaseModel


class JoinOutcome(StrEnum):
    LIVE = "live"  # bot is in the meeting room, capturing
    IN_LOBBY = "in_lobby"  # waiting on host/organizer admission
    DENIED = "denied"  # explicitly rejected by the platform or a host
    ENDED = "ended"  # meeting concluded normally while the bot was present
    FAILED = "failed"  # join mechanics broke (bad URL, page error, etc.)


class BotRosterEntry(BaseModel):
    display_name: str
    platform_user_id: str | None = None
    joined_at_s: float | None = None
    left_at_s: float | None = None


class MeetingJoiner(Protocol):
    """One join attempt against one meeting URL. Implementations: Playwright
    guest-join flows for meet.google.com, teams.live.com/teams.microsoft.com,
    and a zoom.us web-client fallback (only used when RTMS isn't enabled)."""

    platform: str  # "google_meet" | "teams" | "zoom"

    async def join(self, join_url: str, *, display_name: str = "VisualSprint Notetaker") -> JoinOutcome:
        """Navigate to the meeting and attempt to join as a named guest.
        Disclosure is not optional (docs/03-capture.md: 'no stealth capture
        under any framing') -- display_name and any in-meeting chat
        announcement are the implementation's job, not a caller option."""
        ...

    async def poll_status(self) -> JoinOutcome:
        """Re-check current state without re-navigating -- used to detect a
        lobby admission, a host removing the bot, or the meeting ending."""
        ...

    async def roster(self) -> list[BotRosterEntry]:
        """Best-effort participant list scraped from the platform's own UI.
        Feeds identity fusion (ROSTER resolution) the same way Meet/Teams
        transcript speaker labels do for Mode A2 -- see
        app/speakers/identity.py."""
        ...

    async def leave(self) -> None:
        """Depart the meeting and release the underlying browser page."""
        ...


class AudioChunk(BaseModel):
    seq: int
    data: bytes  # raw chunk as captured (webm/opus from MediaRecorder)
    captured_at_s: float


class BotAudioCapture(Protocol):
    """Captures mixed meeting audio from a live MeetingJoiner's page via Web
    Audio API injection. Yields chunks so the runner can flush to blob
    storage incrementally rather than holding a whole meeting in memory."""

    async def start(self) -> None: ...

    def chunks(self) -> AsyncIterator[AudioChunk]: ...

    async def stop(self) -> bytes:
        """Stop capture and return any final buffered audio not yet yielded
        through `chunks()`."""
        ...


class ScreenFrame(BaseModel):
    captured_at_s: float
    image_bytes: bytes  # JPEG


class BotScreenCapture(Protocol):
    """1fps screenshot loop over a live MeetingJoiner's page -- feeds the
    same keyframe/OCR pipeline as Mode A2's video_uri (app/screen/), just
    sourced from the bot's own view instead of a platform recording."""

    async def start(self) -> None: ...

    def frames(self) -> AsyncIterator[ScreenFrame]: ...

    async def stop(self) -> None: ...
