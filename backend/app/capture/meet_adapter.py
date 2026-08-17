"""Google Meet REST API adapter — Capture Mode A2.

Requires Workspace Business Standard+ with auto-recording and auto-transcription
turned on for the space (docs/03-capture.md); tier detection at onboarding is a
different workstream's concern, not this adapter's.

We deliberately never read `TranscriptEntry.text` — Meet's own transcript can't
handle Sinhala/Tamil code-switching (that's downstream ASR's job). Only each entry's
participant + start/end timing is kept, as a speaker-label signal for identity fusion
with pyannote diarization.

ASSUMPTIONS (not live-tested against the real API — field names follow the documented
Meet REST v2 resource shapes as of this writing):
- `capture_session_id` passed to `acquire()` IS the Meet `conferenceRecord` id
  (e.g. "abc-defg-hij"); resolving a scheduled meeting to that id is scheduling-time
  integration owned by a different workstream.
- The Meet API itself does not serve recording bytes. `Recording.driveDestination`
  points at a Google Drive file; the actual audio/video download goes through the
  Drive API (`drive.googleapis.com/v3/files/{fileId}?alt=media`), using the same
  OAuth token (Drive scope must be granted alongside Meet scopes).
- Recording exports are an MP4 container (video+mixed audio); we ingest the whole
  file as a `mixed` AudioTrack — no per-participant separation for Meet.
"""

from datetime import datetime
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

MEET_API_BASE = "https://meet.googleapis.com/v2"
DRIVE_API_BASE = "https://www.googleapis.com/drive/v3"


def _parse_rfc3339(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


class MeetAdapter:
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
        # capture_session_id is the Meet room code (e.g. "abc-defg-hij") stored
        # by detect_conferencing. The conferenceRecord ID is a separate concept --
        # one room can host many meetings over time, each producing a different
        # conferenceRecord. Resolve the most recent record for this room first.
        headers = await self._auth_headers()
        conference_record_id = await self._resolve_conference_record_id(capture_session_id, headers)

        conference_record = await self._get_conference_record(conference_record_id, headers)
        conference_start = _parse_rfc3339(conference_record["startTime"])

        participants = await self._list_participants(conference_record_id, headers)
        roster, names_by_resource = self._build_roster(participants)

        recordings = await self._list_recordings(conference_record_id, headers)
        audio_tracks = await self._fetch_audio_tracks(conference_record_id, recordings, headers)

        transcripts = await self._list_transcripts(conference_record_id, headers)
        speaker_labels: list[SpeakerLabelSpan] = []
        platform_transcript_uri: str | None = None
        for transcript in transcripts:
            export_uri = transcript.get("docsDestination", {}).get("exportUri")
            if export_uri:
                platform_transcript_uri = export_uri
            entries = await self._list_transcript_entries(transcript["name"], headers)
            for entry in entries:
                display_name = names_by_resource.get(entry.get("participant", ""), "Unknown")
                speaker_labels.append(
                    SpeakerLabelSpan(
                        start_s=(
                            _parse_rfc3339(entry["startTime"]) - conference_start
                        ).total_seconds(),
                        end_s=(_parse_rfc3339(entry["endTime"]) - conference_start).total_seconds(),
                        display_name=display_name,
                    )
                )

        return CaptureArtifacts(
            mode=self.mode,
            audio_tracks=audio_tracks,
            roster=roster,
            speaker_labels=speaker_labels,
            platform_transcript_uri=platform_transcript_uri,
        )

    async def _resolve_conference_record_id(self, room_code: str, headers: dict[str, str]) -> str:
        """Converts a Meet room code (e.g. "abc-defg-hij") to the most recent
        conferenceRecord ID. The Meet conferenceRecords.list API supports
        filtering by space.meeting_code (AIP-160 filter syntax)."""
        params = {"filter": f'space.meeting_code = "{room_code}"', "pageSize": "10"}
        resp = await self._client.get(
            f"{MEET_API_BASE}/conferenceRecords", headers=headers, params=params
        )
        resp.raise_for_status()
        records = resp.json().get("conferenceRecords", [])
        if not records:
            raise RuntimeError(
                f"no conferenceRecord found for Meet room code {room_code!r} -- "
                "the meeting may not have started yet, or recording may be unavailable "
                "for this workspace plan (requires Business Standard+)"
            )
        def _sort_key(r: dict) -> str:
            return r.get("endTime") or r.get("startTime") or ""
        latest = max(records, key=_sort_key)
        name = latest["name"]  # "conferenceRecords/{id}"
        return name.rsplit("/", 1)[-1]

    async def _auth_headers(self) -> dict[str, str]:
        token = await self._tokens.get_token()
        return {"Authorization": f"Bearer {token}"}

    async def _get_conference_record(
        self, conference_record_id: str, headers: dict[str, str]
    ) -> dict[str, Any]:
        resp = await self._client.get(
            f"{MEET_API_BASE}/conferenceRecords/{conference_record_id}", headers=headers
        )
        resp.raise_for_status()
        data: dict[str, Any] = resp.json()
        return data

    async def _list_participants(
        self, conference_record_id: str, headers: dict[str, str]
    ) -> list[dict[str, Any]]:
        resp = await self._client.get(
            f"{MEET_API_BASE}/conferenceRecords/{conference_record_id}/participants",
            headers=headers,
        )
        resp.raise_for_status()
        data: dict[str, Any] = resp.json()
        return data.get("participants", [])

    def _build_roster(
        self, participants: list[dict[str, Any]]
    ) -> tuple[list[RosterEntry], dict[str, str]]:
        roster: list[RosterEntry] = []
        names_by_resource: dict[str, str] = {}
        for p in participants:
            info = p.get("signedinUser") or p.get("anonymousUser") or p.get("phoneUser") or {}
            display_name = info.get("displayName", "Unknown")
            platform_user_id = info.get("user")  # e.g. "users/1234567890"; absent for anon/phone
            roster.append(RosterEntry(display_name=display_name, platform_user_id=platform_user_id))
            names_by_resource[p["name"]] = display_name
        return roster, names_by_resource

    async def _list_recordings(
        self, conference_record_id: str, headers: dict[str, str]
    ) -> list[dict[str, Any]]:
        resp = await self._client.get(
            f"{MEET_API_BASE}/conferenceRecords/{conference_record_id}/recordings", headers=headers
        )
        resp.raise_for_status()
        data: dict[str, Any] = resp.json()
        return data.get("recordings", [])

    async def _fetch_audio_tracks(
        self, conference_record_id: str, recordings: list[dict[str, Any]], headers: dict[str, str]
    ) -> list[AudioTrack]:
        tracks: list[AudioTrack] = []
        for i, recording in enumerate(recordings):
            drive_dest = recording.get("driveDestination")
            if not drive_dest or not drive_dest.get("file"):
                # not yet generated — surfaces as a coverage gap upstream, not our concern here
                continue
            file_id = drive_dest["file"]
            download_url = f"{DRIVE_API_BASE}/files/{file_id}?alt=media"
            blob_uri = await download_and_store(
                source_url=download_url,
                blob_store=self._blobs,
                blob_key=f"meet/{conference_record_id}/recording-{i}",
                http_client=self._client,
                source_suffix=".mp4",
                extra_headers=headers,
            )
            tracks.append(AudioTrack(uri=blob_uri, participant=None))
        return tracks

    async def _list_transcripts(
        self, conference_record_id: str, headers: dict[str, str]
    ) -> list[dict[str, Any]]:
        resp = await self._client.get(
            f"{MEET_API_BASE}/conferenceRecords/{conference_record_id}/transcripts", headers=headers
        )
        resp.raise_for_status()
        data: dict[str, Any] = resp.json()
        return data.get("transcripts", [])

    async def _list_transcript_entries(
        self, transcript_name: str, headers: dict[str, str]
    ) -> list[dict[str, Any]]:
        entries: list[dict[str, Any]] = []
        page_token: str | None = None
        while True:
            params = {"pageToken": page_token} if page_token else {}
            resp = await self._client.get(
                f"{MEET_API_BASE}/{transcript_name}/entries", headers=headers, params=params
            )
            resp.raise_for_status()
            data = resp.json()
            entries.extend(data.get("transcriptEntries", []))
            page_token = data.get("nextPageToken")
            if not page_token:
                break
        return entries
