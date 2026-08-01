"""Zoom Cloud Recording API adapter — Capture Mode A2.

ASSUMPTION (per docs/03-capture.md): the account setting "record a separate audio
file for each participant" is enabled. When it is, `GET /meetings/{id}/recordings`
includes a `participant_audio_files` array alongside the mixed `recording_files` —
each entry is one participant's isolated audio track. That yields EXACT attribution,
no diarization needed downstream, so each becomes its own `AudioTrack` with
`participant` set.

Field-shape caveat: Zoom's documented `participant_audio_files` schema does not
include a direct participant-id/email field on each file — only recording_start/
recording_end timing. Identity is therefore resolved by joining against the Report
API's `GET /report/meetings/{id}/participants` (join_time/leave_time) with a small
overlap tolerance. This join is a best-effort inference, not a guaranteed exact
match; unmatched files still produce a usable (unlabelled) per-participant-shaped
track rather than being dropped.

If the account setting turns out to be disabled after all, we fall back to the mixed
`recording_files` audio-only track so the pipeline degrades to diarization instead of
failing outright — never silent data loss, per the coverage-honesty rule.
"""

from datetime import datetime, timedelta
from typing import Any

import httpx

from app.capture.blob_ingest import download_and_store
from app.capture.token_provider import TokenProvider
from app.interfaces.blobstore import BlobStore
from app.interfaces.platform import (
    AudioTrack,
    CaptureArtifacts,
    CaptureMode,
    RosterEntry,
    SpeakerLabelSpan,
)

ZOOM_API_BASE = "https://api.zoom.us/v2"
MATCH_TOLERANCE = timedelta(seconds=5)


def _parse_rfc3339(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


class ZoomAdapter:
    mode = CaptureMode.OFFICIAL_ARTIFACTS

    def __init__(
        self,
        *,
        token_provider: TokenProvider,
        blob_store: BlobStore,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._tokens = token_provider
        self._blobs = blob_store
        self._client = http_client or httpx.AsyncClient()

    async def acquire(self, capture_session_id: str) -> CaptureArtifacts:
        # ASSUMPTION: capture_session_id is the Zoom meeting id/UUID, populated by
        # scheduling-time integration outside this workstream.
        meeting_id = capture_session_id
        headers = await self._auth_headers()

        recordings = await self._get_recordings(meeting_id, headers)
        participants = await self._get_report_participants(meeting_id, headers)
        roster = self._build_roster(participants)

        audio_tracks: list[AudioTrack] = []
        speaker_labels: list[SpeakerLabelSpan] = []

        per_participant_files = recordings.get("participant_audio_files", [])
        if per_participant_files:
            for i, f in enumerate(per_participant_files):
                matched = self._match_participant(f, participants)
                participant_entry = (
                    RosterEntry(display_name=matched["name"], email=matched.get("user_email"))
                    if matched
                    else RosterEntry(display_name=f"unmatched-participant-{i}")
                )
                blob_uri = await self._download_audio(
                    meeting_id, f, headers, tag=f"participant-{i}"
                )
                audio_tracks.append(AudioTrack(uri=blob_uri, participant=participant_entry))
                if matched:
                    speaker_labels.append(
                        SpeakerLabelSpan(
                            start_s=0.0,
                            end_s=self._duration_s(f),
                            display_name=participant_entry.display_name,
                        )
                    )
        else:
            # Setting turned out disabled, or Zoom returned only the mixed track —
            # degrade to diarization rather than fail outright.
            for i, f in enumerate(recordings.get("recording_files", [])):
                if f.get("recording_type") != "audio_only":
                    continue
                blob_uri = await self._download_audio(meeting_id, f, headers, tag=f"mixed-{i}")
                audio_tracks.append(AudioTrack(uri=blob_uri, participant=None))

        return CaptureArtifacts(
            mode=self.mode,
            audio_tracks=audio_tracks,
            roster=roster,
            speaker_labels=speaker_labels,
        )

    async def _auth_headers(self) -> dict[str, str]:
        token = await self._tokens.get_token()
        return {"Authorization": f"Bearer {token}"}

    async def _get_recordings(self, meeting_id: str, headers: dict[str, str]) -> dict[str, Any]:
        resp = await self._client.get(
            f"{ZOOM_API_BASE}/meetings/{meeting_id}/recordings", headers=headers
        )
        resp.raise_for_status()
        data: dict[str, Any] = resp.json()
        return data

    async def _get_report_participants(
        self, meeting_id: str, headers: dict[str, str]
    ) -> list[dict[str, Any]]:
        participants: list[dict[str, Any]] = []
        next_page_token = ""
        while True:
            params: dict[str, str | int] = {"page_size": 300}
            if next_page_token:
                params["next_page_token"] = next_page_token
            resp = await self._client.get(
                f"{ZOOM_API_BASE}/report/meetings/{meeting_id}/participants",
                headers=headers,
                params=params,
            )
            resp.raise_for_status()
            data = resp.json()
            participants.extend(data.get("participants", []))
            next_page_token = data.get("next_page_token", "")
            if not next_page_token:
                break
        return participants

    def _build_roster(self, participants: list[dict[str, Any]]) -> list[RosterEntry]:
        return [
            RosterEntry(
                display_name=p.get("name", "Unknown"),
                platform_user_id=p.get("user_id") or p.get("id"),
                email=p.get("user_email") or None,
            )
            for p in participants
        ]

    def _duration_s(self, audio_file: dict[str, Any]) -> float:
        start = _parse_rfc3339(audio_file["recording_start"])
        end = _parse_rfc3339(audio_file["recording_end"])
        return (end - start).total_seconds()

    def _match_participant(
        self, audio_file: dict[str, Any], participants: list[dict[str, Any]]
    ) -> dict[str, Any] | None:
        """Best-overlap join, not first-match — simultaneous participants otherwise
        collide against whichever roster entry happens to sort first."""
        try:
            rec_start = _parse_rfc3339(audio_file["recording_start"])
            rec_end = _parse_rfc3339(audio_file["recording_end"])
        except (KeyError, ValueError):
            return None
        best: dict[str, Any] | None = None
        best_overlap = timedelta(0)
        for p in participants:
            try:
                p_join = _parse_rfc3339(p["join_time"])
                p_leave = _parse_rfc3339(p["leave_time"])
            except (KeyError, ValueError):
                continue
            overlap_start = max(rec_start, p_join - MATCH_TOLERANCE)
            overlap_end = min(rec_end, p_leave + MATCH_TOLERANCE)
            overlap = overlap_end - overlap_start
            if overlap > best_overlap:
                best_overlap = overlap
                best = p
        return best

    async def _download_audio(
        self, meeting_id: str, audio_file: dict[str, Any], headers: dict[str, str], *, tag: str
    ) -> str:
        extension = audio_file.get("file_extension", "m4a").lower()
        return await download_and_store(
            source_url=audio_file["download_url"],
            blob_store=self._blobs,
            blob_key=f"zoom/{meeting_id}/{tag}",
            http_client=self._client,
            source_suffix=f".{extension}",
            extra_headers=headers,
        )
