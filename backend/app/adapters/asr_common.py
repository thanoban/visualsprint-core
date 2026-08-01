"""Shared types for ASR vendor adapters (Google/Azure/Groq).

Not part of app.interfaces — vendor adapters normalize into these first,
then the cascade (app.asr.cascade) normalizes again into the public
TranscriptSegment/TranscriptionResult shapes from app.interfaces.transcriber.
Nothing downstream of the cascade should ever see these types.
"""

from pydantic import BaseModel, Field


class VendorWord(BaseModel):
    text: str
    start_s: float
    end_s: float
    confidence: float = Field(ge=0.0, le=1.0, default=1.0)


class RawVendorResult(BaseModel):
    text: str
    words: list[VendorWord] = []
    confidence: float = Field(ge=0.0, le=1.0, default=1.0)
    provider: str  # e.g. "google:chirp_2:si-LK", "azure:ta-IN", "groq:whisper-v3-turbo"


class VendorTranscriptionError(Exception):
    """Raised by an adapter on vendor error, timeout, or missing credentials.

    The cascade catches this specifically to trigger auto-failover (si/ta)
    or a coverage-gap segment (en) — it must never leak past the adapter
    boundary as a bare vendor SDK exception.
    """
