"""PlatformAdapter swap point — one interface over all capture modes.

Implementations: Mode D upload (first), Meet REST artifacts, Zoom Cloud
Recording, Zoom RTMS, Teams Graph, bot fallback. Downstream consumes only
the normalized CaptureArtifacts; weaker modes yield honestly lower
attribution confidence, never silent degradation.
"""

from enum import StrEnum
from typing import Protocol

from pydantic import BaseModel


class CaptureMode(StrEnum):
    OFFICIAL_REALTIME = "A1"  # Zoom RTMS
    OFFICIAL_ARTIFACTS = "A2"  # Meet REST / Zoom Cloud Rec / Teams Graph
    BOT = "B"
    DESKTOP = "C"
    UPLOAD = "D"


class RosterEntry(BaseModel):
    display_name: str
    platform_user_id: str | None = None
    email: str | None = None


class SpeakerLabelSpan(BaseModel):
    """Platform-supplied speaker label (e.g. from Meet/Teams transcript) for identity fusion."""

    start_s: float
    end_s: float
    display_name: str


class AudioTrack(BaseModel):
    uri: str  # blob-store URI (FLAC)
    participant: RosterEntry | None = None  # set → per-participant track (Zoom); None → mixed


class CaptureArtifacts(BaseModel):
    mode: CaptureMode
    audio_tracks: list[AudioTrack]
    video_uri: str | None = None  # composited recording for keyframe extraction
    screen_share_uri: str | None = None  # dedicated share stream when platform provides it
    roster: list[RosterEntry] = []
    speaker_labels: list[SpeakerLabelSpan] = []  # identity-fusion signal
    platform_transcript_uri: str | None = None  # free cross-check, never our transcript


class PlatformAdapter(Protocol):
    mode: CaptureMode

    async def acquire(self, capture_session_id: str) -> CaptureArtifacts:
        """Fetch/receive all artifacts for a finished (or live) meeting into blob storage."""
        ...
