"""Vexa 0.12 meetings contract; source: https://docs.vexa.ai/api/meetings.

The caller owns a tenant-scoped HTTP client and its credentials. No module-global
key, automatic retry, tenant lookup, orchestration or live task is hidden here.
Initial qualification uses provider transcripts and explicitly disables recordings
until the hard-deadline deletion worker has been implemented and validated.
"""

from typing import Any
from urllib.parse import quote

import httpx
from pydantic import ValidationError

from app.interfaces.capture_provider import (
    CaptureProviderError,
    CaptureReference,
    CaptureSnapshot,
    CaptureStatus,
    MeetingTarget,
    TranscriptSegment,
    TranscriptSnapshot,
)

_STATUSES = {
    "idle": CaptureStatus.SCHEDULED,
    "scheduled": CaptureStatus.SCHEDULED,
    "requested": CaptureStatus.JOINING,
    "joining": CaptureStatus.JOINING,
    "awaiting_admission": CaptureStatus.WAITING,
    "needs_help": CaptureStatus.BLOCKED,
    "active": CaptureStatus.CAPTURING,
    "stopping": CaptureStatus.STOPPING,
    "completed": CaptureStatus.ENDED,
    "failed": CaptureStatus.FAILED,
}


class VexaCaptureProvider:
    def __init__(self, client: httpx.AsyncClient):
        self.client = client

    async def _request(self, method: str, path: str, *, dispatch: bool = False,
                       missing_ok: bool = False, **kwargs: Any) -> dict[str, Any]:
        try:
            response = await self.client.request(method, path, follow_redirects=False, **kwargs)
        except httpx.RequestError:
            raise CaptureProviderError("vexa_transport_error", retryable=not dispatch,
                                       uncertain=dispatch) from None
        if missing_ok and response.status_code == 404:
            return {}
        if not 200 <= response.status_code < 300:
            status = response.status_code
            raise CaptureProviderError(
                f"vexa_http_{status}",
                retryable=not dispatch and (status == 429 or status >= 500),
                uncertain=dispatch and (status >= 500 or 300 <= status < 400),
            )
        if response.status_code == 204:
            return {}
        try:
            body = response.json()
            if not isinstance(body, dict):
                raise ValueError("expected object")
            return body
        except ValueError:
            raise CaptureProviderError("vexa_invalid_response", uncertain=dispatch) from None

    @staticmethod
    def _snapshot(body: dict[str, Any], reference: CaptureReference) -> CaptureSnapshot:
        # Native-id endpoints resolve the newest occurrence; use immutable record IDs for reads.
        if str(body.get("id", "")) != reference.record_id:
            raise CaptureProviderError("vexa_record_mismatch")
        if (body.get("platform") != reference.platform
                or body.get("native_meeting_id") != reference.native_meeting_id):
            raise CaptureProviderError("vexa_meeting_mismatch")
        raw = body.get("status")
        state = raw if isinstance(raw, str) and raw in _STATUSES else "unknown"
        return CaptureSnapshot(reference=reference, provider_status=state,
                               status=_STATUSES.get(state, CaptureStatus.UNKNOWN))

    @staticmethod
    def _record_path(reference: CaptureReference) -> str:
        if reference.provider != "vexa":
            raise CaptureProviderError("wrong_capture_provider")
        return quote(reference.record_id, safe="")

    async def start(self, target: MeetingTarget) -> CaptureSnapshot:
        # Re-parse rather than trust an externally constructed model's platform/id.
        validated = MeetingTarget.from_url(target.meeting_url)
        if validated != target:
            raise CaptureProviderError("invalid_meeting_target")
        body = await self._request("POST", "/bots", dispatch=True, json={
            "meeting_url": target.meeting_url,
            "bot_name": "VisualSprint Notetaker",
            "language": "en",
            "transcribe_enabled": True,
            "recording_enabled": False,
        })
        try:
            record_id = body.get("id")
            if isinstance(record_id, bool) or not isinstance(record_id, (str, int)):
                raise ValueError("missing record id")
            reference = CaptureReference(provider="vexa", record_id=str(record_id),
                                         platform=target.platform,
                                         native_meeting_id=target.native_meeting_id)
            return self._snapshot(body, reference)
        except (ValueError, CaptureProviderError):
            # Successful HTTP with an unusable body is still an ambiguous dispatch.
            raise CaptureProviderError("vexa_dispatch_unresolved", uncertain=True) from None

    async def status(self, reference: CaptureReference) -> CaptureSnapshot:
        body = await self._request("GET", f"/meetings/{self._record_path(reference)}")
        return self._snapshot(body, reference)

    async def transcript(self, reference: CaptureReference) -> TranscriptSnapshot:
        body = await self._request("GET", f"/transcripts/by-id/{self._record_path(reference)}")
        capture = self._snapshot(body, reference)
        try:
            raw_segments = body["segments"]
            if not isinstance(raw_segments, list):
                raise ValueError("segments must be an array")
            segments: dict[str, TranscriptSegment] = {}
            for row in raw_segments:
                segment = TranscriptSegment(
                    id=row["segment_id"], start_s=row["start"], end_s=row["end"],
                    text=row["text"], speaker_label=row.get("speaker") or None,
                    language=row.get("language"), final=row.get("completed", False),
                    confidence=row.get("confidence"),
                )
                previous = segments.get(segment.id)
                # A late draft must not replace a final segment from the same snapshot.
                if previous is None or not previous.final or segment.final:
                    segments[segment.id] = segment
            return TranscriptSnapshot(capture=capture, segments=sorted(
                segments.values(), key=lambda s: (s.start_s, s.id)))
        except (KeyError, TypeError, ValueError, ValidationError):
            raise CaptureProviderError("vexa_invalid_transcript") from None

    async def stop(self, reference: CaptureReference) -> None:
        current = await self.status(reference)
        if current.status in {CaptureStatus.ENDED, CaptureStatus.FAILED}:
            return
        if current.status == CaptureStatus.SCHEDULED:
            raise CaptureProviderError("vexa_cancel_plan_required")
        if current.status == CaptureStatus.UNKNOWN:
            raise CaptureProviderError("vexa_unknown_status")
        platform = quote(reference.platform, safe="")
        native_id = quote(reference.native_meeting_id, safe="")
        # Provider stop is native-keyed. Dispatcher must serialize occurrences of this
        # native key; the immutable-ID check above prevents ordinary stale-stop requests.
        await self._request("DELETE", f"/bots/{platform}/{native_id}")

    async def delete_artifacts(self, reference: CaptureReference) -> None:
        try:
            current = await self.status(reference)
        except CaptureProviderError as exc:
            if exc.code == "vexa_http_404":
                return
            raise
        if current.status not in {CaptureStatus.ENDED, CaptureStatus.FAILED}:
            raise CaptureProviderError("vexa_not_terminal")
        # Provider returns 409 for a live record; never turn that into successful deletion.
        await self._request("DELETE", f"/meetings/{self._record_path(reference)}", missing_ok=True)
