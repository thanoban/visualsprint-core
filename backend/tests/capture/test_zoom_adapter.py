import httpx
import pytest

from app.capture.token_provider import StaticTokenProvider
from app.capture.zoom_adapter import ZoomAdapter
from app.interfaces.platform import CaptureMode
from tests.capture.fakes import InMemoryBlobStore

MEETING_ID = "meeting-789"

RECORDINGS = {
    "uuid": "uuid-1",
    "id": 123456789,
    "topic": "Weekly Standup",
    "start_time": "2026-08-01T10:00:00Z",
    "recording_files": [
        {
            "id": "rf-mixed",
            "recording_type": "audio_only",
            "file_extension": "M4A",
            "download_url": "https://zoom.example.com/rec/download/mixed.m4a",
            "recording_start": "2026-08-01T10:00:00Z",
            "recording_end": "2026-08-01T10:30:00Z",
        }
    ],
    "participant_audio_files": [
        {
            "id": "pf-1",
            "file_extension": "M4A",
            "download_url": "https://zoom.example.com/rec/download/p1.m4a",
            "recording_start": "2026-08-01T10:00:00Z",
            "recording_end": "2026-08-01T10:15:00Z",
        },
        {
            "id": "pf-2",
            "file_extension": "M4A",
            "download_url": "https://zoom.example.com/rec/download/p2.m4a",
            "recording_start": "2026-08-01T10:15:00Z",
            "recording_end": "2026-08-01T10:30:00Z",
        },
    ],
}

REPORT_PARTICIPANTS = {
    "page_size": 300,
    "total_records": 2,
    "next_page_token": "",
    "participants": [
        {
            "id": "u1",
            "user_id": "u1",
            "name": "Alice",
            "user_email": "alice@example.com",
            "join_time": "2026-08-01T09:59:50Z",
            "leave_time": "2026-08-01T10:15:05Z",
        },
        {
            "id": "u2",
            "user_id": "u2",
            "name": "Bob",
            "user_email": "bob@example.com",
            "join_time": "2026-08-01T10:14:55Z",
            "leave_time": "2026-08-01T10:30:05Z",
        },
    ],
}

FAKE_AUDIO = b"FAKE-M4A-BYTES"


def make_zoom_transport() -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == f"https://api.zoom.us/v2/meetings/{MEETING_ID}/recordings":
            assert request.headers.get("authorization") == "Bearer zoom-token"
            return httpx.Response(200, json=RECORDINGS)
        if url.startswith(f"https://api.zoom.us/v2/report/meetings/{MEETING_ID}/participants"):
            return httpx.Response(200, json=REPORT_PARTICIPANTS)
        if url.startswith("https://zoom.example.com/rec/download/"):
            return httpx.Response(200, content=FAKE_AUDIO)
        raise AssertionError(f"unexpected request: {request.method} {url}")

    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_zoom_adapter_produces_per_participant_tracks():
    blob_store = InMemoryBlobStore()
    client = httpx.AsyncClient(transport=make_zoom_transport())
    adapter = ZoomAdapter(
        token_provider=StaticTokenProvider("zoom-token"),
        blob_store=blob_store,
        http_client=client,
    )

    artifacts = await adapter.acquire(MEETING_ID)

    assert artifacts.mode == CaptureMode.OFFICIAL_ARTIFACTS

    # Per-participant setting is on -> exactly 2 tracks, not the mixed one.
    assert len(artifacts.audio_tracks) == 2
    for track in artifacts.audio_tracks:
        assert track.participant is not None
        assert blob_store.objects[track.uri] == FAKE_AUDIO

    names = {t.participant.display_name for t in artifacts.audio_tracks}
    assert names == {"Alice", "Bob"}

    # First file (10:00-10:15) should join to Alice (whose session overlaps it most),
    # second (10:15-10:30) to Bob.
    by_name = {t.participant.display_name: t for t in artifacts.audio_tracks}
    assert by_name["Alice"].participant.email == "alice@example.com"
    assert by_name["Bob"].participant.email == "bob@example.com"

    assert {r.display_name for r in artifacts.roster} == {"Alice", "Bob"}

    assert len(artifacts.speaker_labels) == 2
    labels_by_name = {s.display_name: s for s in artifacts.speaker_labels}
    assert labels_by_name["Alice"].end_s == pytest.approx(900.0)  # 15 min
    assert labels_by_name["Bob"].end_s == pytest.approx(900.0)


@pytest.mark.asyncio
async def test_zoom_adapter_falls_back_to_mixed_track_when_no_per_participant_files():
    blob_store = InMemoryBlobStore()

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == f"https://api.zoom.us/v2/meetings/{MEETING_ID}/recordings":
            recordings_no_pf = {
                k: v for k, v in RECORDINGS.items() if k != "participant_audio_files"
            }
            return httpx.Response(200, json=recordings_no_pf)
        if url.startswith(f"https://api.zoom.us/v2/report/meetings/{MEETING_ID}/participants"):
            return httpx.Response(200, json={"participants": []})
        if url.startswith("https://zoom.example.com/rec/download/"):
            return httpx.Response(200, content=FAKE_AUDIO)
        raise AssertionError(f"unexpected request: {request.method} {url}")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    adapter = ZoomAdapter(
        token_provider=StaticTokenProvider("zoom-token"),
        blob_store=blob_store,
        http_client=client,
    )

    artifacts = await adapter.acquire(MEETING_ID)

    assert len(artifacts.audio_tracks) == 1
    assert artifacts.audio_tracks[0].participant is None
    assert artifacts.speaker_labels == []
