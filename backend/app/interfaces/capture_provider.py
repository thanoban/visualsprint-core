"""Provider-neutral contracts for the founder-platform capture replacement.

Dispatch acceptance is not admission. Lifecycle and transcript completeness are
separate facts. Adapters must not retry an ambiguous create operation themselves.
"""

import re
from enum import StrEnum
from typing import Protocol
from urllib.parse import unquote, urlsplit

from pydantic import BaseModel, ConfigDict, Field, model_validator


class CaptureStatus(StrEnum):
    SCHEDULED = "scheduled"
    JOINING = "joining"
    WAITING = "waiting_for_admission"
    BLOCKED = "blocked"
    CAPTURING = "capturing"
    STOPPING = "stopping"
    ENDED = "ended"
    FAILED = "failed"
    UNKNOWN = "unknown"


class MeetingTarget(BaseModel):
    model_config = ConfigDict(frozen=True)

    platform: str
    native_meeting_id: str
    # Contains credentials on Zoom/Teams: never log this model or serialize to a public response.
    meeting_url: str = Field(repr=False)

    @classmethod
    def from_url(cls, url: str) -> "MeetingTarget":
        if len(url) > 4096 or any(ch.isspace() for ch in url):
            raise ValueError("expected a single meeting URL")
        parsed = urlsplit(url)
        host = (parsed.hostname or "").lower()
        if (parsed.scheme != "https" or parsed.username or parsed.password
                or parsed.port not in (None, 443) or parsed.fragment):
            raise ValueError("expected an HTTPS meeting URL without userinfo or fragment")
        path = parsed.path.rstrip("/")
        if host == "meet.google.com":
            match = re.fullmatch(r"/([a-z]{3}-[a-z]{4}-[a-z]{3})", path, re.I)
            if match:
                return cls(platform="google_meet", native_meeting_id=match[1].lower(),
                           meeting_url=url)
        if host == "zoom.us" or host.endswith(".zoom.us"):
            match = re.fullmatch(r"/(?:j/|wc/(?:join/)?)(\d{9,11})", path)
            if match:
                return cls(platform="zoom", native_meeting_id=match[1], meeting_url=url)
        if host in {"teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"}:
            match = re.fullmatch(r"/meet/(\d{10,15})", path)
            if match:
                return cls(platform="teams", native_meeting_id=match[1], meeting_url=url)
            match = re.fullmatch(r"/l/meetup-join/([^/]+)/0", path)
            if match:
                native_id = unquote(match[1])
                if re.fullmatch(r"19:meeting_[A-Za-z0-9_=-]+@thread\.v2", native_id):
                    return cls(platform="teams", native_meeting_id=native_id, meeting_url=url)
        raise ValueError("unsupported meeting link; use a Meet, Zoom, or Teams invitation URL")


class CaptureReference(BaseModel):
    model_config = ConfigDict(frozen=True)

    provider: str
    record_id: str = Field(min_length=1)
    platform: str
    native_meeting_id: str = Field(min_length=1)


class CaptureSnapshot(BaseModel):
    reference: CaptureReference
    status: CaptureStatus
    provider_status: str


class TranscriptSegment(BaseModel):
    id: str = Field(min_length=1)
    start_s: float = Field(ge=0, allow_inf_nan=False)
    end_s: float = Field(ge=0, allow_inf_nan=False)
    text: str
    speaker_label: str | None = None
    language: str | None = None
    final: bool = False
    confidence: float | None = Field(default=None, ge=0, le=1, allow_inf_nan=False)

    @model_validator(mode="after")
    def ordered_times(self) -> "TranscriptSegment":
        if self.end_s < self.start_s:
            raise ValueError("transcript segment ends before it starts")
        return self


class TranscriptSnapshot(BaseModel):
    capture: CaptureSnapshot
    segments: list[TranscriptSegment]


class CaptureProviderError(RuntimeError):
    """Safe-to-log error. Never include vendor bodies, keys or meeting URLs."""

    def __init__(self, code: str, *, retryable: bool = False, uncertain: bool = False):
        super().__init__(code)
        self.code = code
        self.retryable = retryable
        # A timed-out dispatch may already have created a bot. Reconcile, do not resend.
        self.uncertain = uncertain


class CaptureProvider(Protocol):
    async def start(self, target: MeetingTarget) -> CaptureSnapshot: ...

    async def status(self, reference: CaptureReference) -> CaptureSnapshot: ...

    async def transcript(self, reference: CaptureReference) -> TranscriptSnapshot: ...

    async def stop(self, reference: CaptureReference) -> None: ...

    async def delete_artifacts(self, reference: CaptureReference) -> None: ...
