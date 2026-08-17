"""Microsoft Teams Graph API adapter — Capture Mode A2.

Same principle as meet_adapter.py: we take the platform's audio and speaker
timing, never its transcript text — Teams' own ASR can't handle Sinhala/Tamil
code-switching, that's downstream ASR's job. Speaker attribution comes from
parsing WebVTT `<v Speaker Name>` voice-tag cues in the transcript export;
only the speaker name and cue timing are read, the cue text itself is
discarded immediately after parsing.

ASSUMPTIONS (not live-tested against the real API — field names follow the
documented Graph v1.0 resource shapes as of this writing):
- `capture_session_id` passed to `acquire()` encodes BOTH ids Graph's
  `/users/{userId}/onlineMeetings/{meetingId}` path requires, as
  `"{user_id}:{meeting_id}"` — resolving a scheduled meeting to that pair is
  scheduling-time integration owned by a different workstream. Application
  permissions (`OnlineMeetings.Read.All`) require the `/users/{id}/` path;
  there is no tenant-wide "just give me this meeting" shortcut.
- Recording/transcript *content* download (`GET .../content`) returns the
  raw bytes directly (MP4 for recordings, WebVTT text for transcripts) —
  no intermediate storage-provider redirect the way Meet's Drive step needs.
- Recording exports are MP4 (video+mixed audio); ingested as one `mixed`
  AudioTrack, same as Meet — Teams' Graph API does not expose separate
  per-participant audio, only the Windows-Server media-bot path would
  (deferred, see docs/03-capture.md).

TEAMS-SPECIFIC RISK (docs/03-capture.md): a tenant admin control gates Graph
transcript access from 29 Jul 2026 — when disabled, the transcripts call
returns 403. That must be detected explicitly, not surfaced as a bare
`HTTPStatusError`, so the caller can fall back to Mode B/C with the
limitation stated rather than failing the whole session. `TeamsAccessGatedError`
carries that signal; the recording call is unaffected by this specific gate
and is not wrapped in it.
"""

import re
from datetime import timedelta
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

GRAPH_API_BASE = "https://graph.microsoft.com/v1.0"

_VTT_TIMESTAMP_RE = re.compile(
    r"(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})"
)
_VTT_VOICE_TAG_RE = re.compile(r"<v\s+([^>]+)>")


class TeamsAccessGatedError(Exception):
    """Raised when the tenant admin has disabled Graph transcript access
    (docs/03-capture.md: gated from 29 Jul 2026). Callers must catch this
    specifically and fall back to Mode B/C with the limitation stated —
    never treat it as a generic failure."""

    def __init__(self, meeting_id: str) -> None:
        self.meeting_id = meeting_id
        super().__init__(
            f"Graph transcript access is disabled for this tenant (meeting {meeting_id}); "
            "the tenant admin control introduced 29 Jul 2026 must be enabled, or fall back "
            "to Mode B/C for this org."
        )


def _parse_vtt_timestamp(h: str, m: str, s: str, ms: str) -> float:
    return timedelta(
        hours=int(h), minutes=int(m), seconds=int(s), milliseconds=int(ms)
    ).total_seconds()


def _parse_webvtt_speaker_spans(vtt_text: str) -> list[SpeakerLabelSpan]:
    """Extracts (speaker, start_s, end_s) from cues shaped like:

        00:00:05.000 --> 00:00:10.000
        <v Alice Chen>Hello there, how's the migration going?</v>

    Cue text after the voice tag is discarded immediately — never stored,
    never returned. A cue with a timestamp but no recognizable voice tag is
    skipped rather than guessed at.
    """
    spans: list[SpeakerLabelSpan] = []
    lines = vtt_text.splitlines()
    i = 0
    while i < len(lines):
        match = _VTT_TIMESTAMP_RE.search(lines[i])
        if match is None:
            i += 1
            continue
        start_s = _parse_vtt_timestamp(*match.groups()[0:4])
        end_s = _parse_vtt_timestamp(*match.groups()[4:8])
        i += 1
        if i < len(lines):
            voice_match = _VTT_VOICE_TAG_RE.search(lines[i])
            if voice_match is not None:
                spans.append(
                    SpeakerLabelSpan(
                        start_s=start_s, end_s=end_s, display_name=voice_match.group(1).strip()
                    )
                )
        i += 1
    return spans


class TeamsAdapter:
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
        headers = await self._auth_headers()
        if capture_session_id.startswith("https://"):
            # capture_session_id is the raw join URL stored by detect_conferencing
            # (the full meetup-join or /meet/ URL). Resolve it to the Graph
            # onlineMeeting id via $filter before proceeding.
            user_id, meeting_id = await self._resolve_from_join_url(capture_session_id, headers)
        else:
            user_id, _, meeting_id = capture_session_id.partition(":")
            if not meeting_id:
                raise ValueError(
                    f"capture_session_id {capture_session_id!r} must be a Teams join URL "
                    "or 'user_id:meeting_id' for Mode A2 Teams capture"
                )

        recordings = await self._list_recordings(user_id, meeting_id, headers)
        audio_tracks = await self._fetch_audio_tracks(user_id, meeting_id, recordings, headers)

        transcripts = await self._list_transcripts(user_id, meeting_id, headers, meeting_id_for_error=meeting_id)
        speaker_labels: list[SpeakerLabelSpan] = []
        for transcript in transcripts:
            vtt_text = await self._fetch_transcript_content(
                user_id, meeting_id, transcript["id"], headers
            )
            speaker_labels.extend(_parse_webvtt_speaker_spans(vtt_text))

        roster = self._roster_from_speaker_labels(speaker_labels)

        return CaptureArtifacts(
            mode=self.mode,
            audio_tracks=audio_tracks,
            roster=roster,
            speaker_labels=speaker_labels,
        )

    async def _resolve_from_join_url(self, join_url: str, headers: dict[str, str]) -> tuple[str, str]:
        """Converts a Teams join URL (meetup-join or /meet/ format) to the
        (user_id, meeting_id) pair the Graph recordings/transcripts APIs require.
        Uses GET /me/onlineMeetings?$filter=joinWebUrl eq '{url}' -- works when
        the authenticated user is the meeting organizer. Non-organizers will get
        an empty result; the RuntimeError surfaces clearly rather than silently
        returning no tracks."""
        resp = await self._client.get(
            f"{GRAPH_API_BASE}/me/onlineMeetings",
            headers=headers,
            params={"$filter": f"joinWebUrl eq '{join_url}'"},
        )
        resp.raise_for_status()
        meetings = resp.json().get("value", [])
        if not meetings:
            raise RuntimeError(
                f"no onlineMeeting found for Teams join URL {join_url!r} -- "
                "the authenticated user must be the meeting organizer for Mode A2 "
                "Teams capture; attendees cannot access recordings via this API"
            )
        meeting = meetings[0]
        meeting_id = meeting["id"]
        organizer_user = (
            meeting.get("participants", {})
            .get("organizer", {})
            .get("identity", {})
            .get("user", {})
        )
        user_id = organizer_user.get("id")
        if not user_id:
            resp_me = await self._client.get(f"{GRAPH_API_BASE}/me", headers=headers)
            resp_me.raise_for_status()
            user_id = resp_me.json()["id"]
        return user_id, meeting_id

    async def _auth_headers(self) -> dict[str, str]:
        token = await self._tokens.get_token()
        return {"Authorization": f"Bearer {token}"}

    def _roster_from_speaker_labels(self, spans: list[SpeakerLabelSpan]) -> list[RosterEntry]:
        seen: dict[str, RosterEntry] = {}
        for span in spans:
            if span.display_name not in seen:
                seen[span.display_name] = RosterEntry(display_name=span.display_name)
        return list(seen.values())

    async def _list_recordings(
        self, user_id: str, meeting_id: str, headers: dict[str, str]
    ) -> list[dict[str, Any]]:
        resp = await self._client.get(
            f"{GRAPH_API_BASE}/users/{user_id}/onlineMeetings/{meeting_id}/recordings",
            headers=headers,
        )
        resp.raise_for_status()
        data: dict[str, Any] = resp.json()
        return data.get("value", [])

    async def _fetch_audio_tracks(
        self,
        user_id: str,
        meeting_id: str,
        recordings: list[dict[str, Any]],
        headers: dict[str, str],
    ) -> list[AudioTrack]:
        tracks: list[AudioTrack] = []
        for recording in recordings:
            recording_id = recording["id"]
            download_url = (
                f"{GRAPH_API_BASE}/users/{user_id}/onlineMeetings/{meeting_id}"
                f"/recordings/{recording_id}/content"
            )
            blob_uri = await download_and_store(
                source_url=download_url,
                blob_store=self._blobs,
                blob_key=f"teams/{meeting_id}/recording-{recording_id}",
                http_client=self._client,
                source_suffix=".mp4",
                extra_headers=headers,
            )
            tracks.append(AudioTrack(uri=blob_uri, participant=None))
        return tracks

    async def _list_transcripts(
        self, user_id: str, meeting_id: str, headers: dict[str, str], *, meeting_id_for_error: str
    ) -> list[dict[str, Any]]:
        resp = await self._client.get(
            f"{GRAPH_API_BASE}/users/{user_id}/onlineMeetings/{meeting_id}/transcripts",
            headers=headers,
        )
        if resp.status_code == 403:
            raise TeamsAccessGatedError(meeting_id_for_error)
        resp.raise_for_status()
        data: dict[str, Any] = resp.json()
        return data.get("value", [])

    async def _fetch_transcript_content(
        self, user_id: str, meeting_id: str, transcript_id: str, headers: dict[str, str]
    ) -> str:
        resp = await self._client.get(
            f"{GRAPH_API_BASE}/users/{user_id}/onlineMeetings/{meeting_id}"
            f"/transcripts/{transcript_id}/content",
            headers={**headers, "Accept": "text/vtt"},
        )
        resp.raise_for_status()
        return resp.text
