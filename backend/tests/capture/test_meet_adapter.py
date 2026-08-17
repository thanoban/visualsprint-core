import httpx
import pytest

from app.capture.meet_adapter import MeetAdapter
from app.capture.token_provider import StaticTokenProvider
from app.interfaces.platform import CaptureMode
from tests.capture.fakes import InMemoryBlobStore

CONFERENCE_ID = "abc123"

CONFERENCE_RECORD = {
    "name": f"conferenceRecords/{CONFERENCE_ID}",
    "startTime": "2026-08-01T10:00:00Z",
    "endTime": "2026-08-01T10:30:00Z",
}

PARTICIPANTS = {
    "participants": [
        {
            "name": f"conferenceRecords/{CONFERENCE_ID}/participants/p1",
            "signedinUser": {"user": "users/111", "displayName": "Alice"},
        },
        {
            "name": f"conferenceRecords/{CONFERENCE_ID}/participants/p2",
            "signedinUser": {"user": "users/222", "displayName": "Bob"},
        },
    ]
}

RECORDINGS = {
    "recordings": [
        {
            "name": f"conferenceRecords/{CONFERENCE_ID}/recordings/r1",
            "state": "FILE_GENERATED",
            "driveDestination": {
                "file": "drive-file-1",
                "exportUri": "https://drive.google.com/file/d/drive-file-1/view",
            },
        }
    ]
}

TRANSCRIPTS = {
    "transcripts": [
        {
            "name": f"conferenceRecords/{CONFERENCE_ID}/transcripts/t1",
            "state": "FILE_GENERATED",
            "docsDestination": {
                "document": "doc1",
                "exportUri": "https://docs.google.com/document/d/doc1/view",
            },
        }
    ]
}

TRANSCRIPT_ENTRIES = {
    "transcriptEntries": [
        {
            "name": f"conferenceRecords/{CONFERENCE_ID}/transcripts/t1/entries/e1",
            "participant": f"conferenceRecords/{CONFERENCE_ID}/participants/p1",
            "text": "hello there",  # never read by the adapter
            "startTime": "2026-08-01T10:00:05Z",
            "endTime": "2026-08-01T10:00:10Z",
        },
        {
            "name": f"conferenceRecords/{CONFERENCE_ID}/transcripts/t1/entries/e2",
            "participant": f"conferenceRecords/{CONFERENCE_ID}/participants/p2",
            "text": "hi Alice",
            "startTime": "2026-08-01T10:00:12Z",
            "endTime": "2026-08-01T10:00:15Z",
        },
    ]
}

FAKE_AUDIO_BYTES = b"FAKE-MP4-BYTES"


ROOM_CODE = "abc-defg-hij"  # room code passed to acquire(), separate from CONFERENCE_ID


def make_meet_transport() -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        # Resolution step: list conferenceRecords filtered by room code
        if url.startswith("https://meet.googleapis.com/v2/conferenceRecords") and "filter" in url:
            assert ROOM_CODE.replace("-", "%2D") in url or ROOM_CODE in url
            return httpx.Response(200, json={"conferenceRecords": [CONFERENCE_RECORD]})
        if url == f"https://meet.googleapis.com/v2/conferenceRecords/{CONFERENCE_ID}":
            return httpx.Response(200, json=CONFERENCE_RECORD)
        if url == f"https://meet.googleapis.com/v2/conferenceRecords/{CONFERENCE_ID}/participants":
            return httpx.Response(200, json=PARTICIPANTS)
        if url == f"https://meet.googleapis.com/v2/conferenceRecords/{CONFERENCE_ID}/recordings":
            return httpx.Response(200, json=RECORDINGS)
        if url == f"https://meet.googleapis.com/v2/conferenceRecords/{CONFERENCE_ID}/transcripts":
            return httpx.Response(200, json=TRANSCRIPTS)
        if url == "https://meet.googleapis.com/v2/conferenceRecords/abc123/transcripts/t1/entries":
            return httpx.Response(200, json=TRANSCRIPT_ENTRIES)
        if url == "https://www.googleapis.com/drive/v3/files/drive-file-1?alt=media":
            assert request.headers.get("authorization") == "Bearer test-token"
            return httpx.Response(200, content=FAKE_AUDIO_BYTES)
        raise AssertionError(f"unexpected request: {request.method} {url}")

    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_meet_adapter_acquire_builds_correct_artifacts():
    blob_store = InMemoryBlobStore()
    client = httpx.AsyncClient(transport=make_meet_transport())
    adapter = MeetAdapter(
        token_provider=StaticTokenProvider("test-token"),
        blob_store=blob_store,
        http_client=client,
    )

    artifacts = await adapter.acquire(ROOM_CODE)

    assert artifacts.mode == CaptureMode.OFFICIAL_ARTIFACTS

    assert len(artifacts.audio_tracks) == 1
    track = artifacts.audio_tracks[0]
    assert track.participant is None  # Meet yields a mixed track only
    assert blob_store.objects[track.uri] == FAKE_AUDIO_BYTES
    assert track.uri.endswith(".mp4")  # no ffmpeg on this machine -> untranscoded fallback

    assert {r.display_name for r in artifacts.roster} == {"Alice", "Bob"}

    assert len(artifacts.speaker_labels) == 2
    by_name = {s.display_name: s for s in artifacts.speaker_labels}
    assert by_name["Alice"].start_s == pytest.approx(5.0)
    assert by_name["Alice"].end_s == pytest.approx(10.0)
    assert by_name["Bob"].start_s == pytest.approx(12.0)
    assert by_name["Bob"].end_s == pytest.approx(15.0)

    assert artifacts.platform_transcript_uri == "https://docs.google.com/document/d/doc1/view"


@pytest.mark.asyncio
async def test_meet_adapter_skips_recordings_without_drive_export():
    blob_store = InMemoryBlobStore()

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.startswith("https://meet.googleapis.com/v2/conferenceRecords") and "filter" in url:
            return httpx.Response(200, json={"conferenceRecords": [CONFERENCE_RECORD]})
        if url == f"https://meet.googleapis.com/v2/conferenceRecords/{CONFERENCE_ID}":
            return httpx.Response(200, json=CONFERENCE_RECORD)
        if url == f"https://meet.googleapis.com/v2/conferenceRecords/{CONFERENCE_ID}/participants":
            return httpx.Response(200, json={"participants": []})
        if url == f"https://meet.googleapis.com/v2/conferenceRecords/{CONFERENCE_ID}/recordings":
            return httpx.Response(
                200,
                json={
                    "recordings": [
                        {"name": "conferenceRecords/abc123/recordings/r1", "state": "STARTED"}
                    ]
                },
            )
        if url == f"https://meet.googleapis.com/v2/conferenceRecords/{CONFERENCE_ID}/transcripts":
            return httpx.Response(200, json={"transcripts": []})
        raise AssertionError(f"unexpected request: {request.method} {url}")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    adapter = MeetAdapter(
        token_provider=StaticTokenProvider("test-token"),
        blob_store=blob_store,
        http_client=client,
    )

    artifacts = await adapter.acquire(ROOM_CODE)

    assert artifacts.audio_tracks == []
    assert artifacts.roster == []
    assert artifacts.speaker_labels == []
