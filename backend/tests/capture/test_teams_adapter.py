import httpx
import pytest

from app.capture.teams_adapter import (
    TeamsAccessGatedError,
    TeamsAdapter,
    _parse_webvtt_speaker_spans,
)
from app.capture.token_provider import StaticTokenProvider
from app.interfaces.platform import CaptureMode
from tests.capture.fakes import InMemoryBlobStore

USER_ID = "u1"
MEETING_ID = "m1"
SESSION_ID = f"{USER_ID}:{MEETING_ID}"
BASE = f"https://graph.microsoft.com/v1.0/users/{USER_ID}/onlineMeetings/{MEETING_ID}"

RECORDINGS = {"value": [{"id": "r1"}]}
TRANSCRIPTS = {"value": [{"id": "t1"}]}
FAKE_MP4_BYTES = b"FAKE-MP4-BYTES"

SAMPLE_VTT = """WEBVTT

00:00:05.000 --> 00:00:10.500
<v Alice Chen>Hello there, how's the migration going?</v>

00:00:11.000 --> 00:00:15.250
<v Bob Fernando>API eka deploy panna ready.</v>
"""


def make_teams_transport() -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == f"{BASE}/recordings":
            return httpx.Response(200, json=RECORDINGS)
        if url == f"{BASE}/recordings/r1/content":
            assert request.headers.get("authorization") == "Bearer test-token"
            return httpx.Response(200, content=FAKE_MP4_BYTES)
        if url == f"{BASE}/transcripts":
            return httpx.Response(200, json=TRANSCRIPTS)
        if url == f"{BASE}/transcripts/t1/content":
            return httpx.Response(200, text=SAMPLE_VTT)
        raise AssertionError(f"unexpected request: {request.method} {url}")

    return httpx.MockTransport(handler)


def test_parse_webvtt_extracts_speaker_and_timing_never_text():
    spans = _parse_webvtt_speaker_spans(SAMPLE_VTT)

    assert len(spans) == 2
    assert spans[0].display_name == "Alice Chen"
    assert spans[0].start_s == pytest.approx(5.0)
    assert spans[0].end_s == pytest.approx(10.5)
    assert spans[1].display_name == "Bob Fernando"
    assert spans[1].start_s == pytest.approx(11.0)
    assert spans[1].end_s == pytest.approx(15.25)

    # The cue text itself must never leak into the parsed result.
    for span in spans:
        assert not hasattr(span, "text")


def test_parse_webvtt_skips_cues_without_a_voice_tag():
    vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nplain text, no voice tag\n"
    assert _parse_webvtt_speaker_spans(vtt) == []


@pytest.mark.asyncio
async def test_teams_adapter_acquire_builds_correct_artifacts():
    blob_store = InMemoryBlobStore()
    client = httpx.AsyncClient(transport=make_teams_transport())
    adapter = TeamsAdapter(
        token_provider=StaticTokenProvider("test-token"), blob_store=blob_store, http_client=client
    )

    artifacts = await adapter.acquire(SESSION_ID)

    assert artifacts.mode == CaptureMode.OFFICIAL_ARTIFACTS

    assert len(artifacts.audio_tracks) == 1
    track = artifacts.audio_tracks[0]
    assert track.participant is None  # Teams Graph yields a mixed track only
    assert blob_store.objects[track.uri] == FAKE_MP4_BYTES

    assert {r.display_name for r in artifacts.roster} == {"Alice Chen", "Bob Fernando"}

    assert len(artifacts.speaker_labels) == 2
    by_name = {s.display_name: s for s in artifacts.speaker_labels}
    assert by_name["Alice Chen"].start_s == pytest.approx(5.0)
    assert by_name["Bob Fernando"].end_s == pytest.approx(15.25)


@pytest.mark.asyncio
async def test_teams_adapter_requires_composite_session_id():
    adapter = TeamsAdapter(
        token_provider=StaticTokenProvider("test-token"),
        blob_store=InMemoryBlobStore(),
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200))),
    )
    with pytest.raises(ValueError, match="user_id:meeting_id"):
        await adapter.acquire("just-a-meeting-id")


@pytest.mark.asyncio
async def test_teams_adapter_raises_named_error_when_tenant_gates_transcript_access():
    """docs/03-capture.md: a tenant admin control gates Graph transcript
    access from 29 Jul 2026 -- when disabled, the caller must be able to
    detect this specifically (to fall back to Mode B/C), not just see a
    bare HTTPStatusError indistinguishable from any other failure."""

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == f"{BASE}/recordings":
            return httpx.Response(200, json={"value": []})
        if url == f"{BASE}/transcripts":
            return httpx.Response(403, json={"error": {"message": "Access denied by tenant policy"}})
        raise AssertionError(f"unexpected request: {request.method} {url}")

    adapter = TeamsAdapter(
        token_provider=StaticTokenProvider("test-token"),
        blob_store=InMemoryBlobStore(),
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )

    with pytest.raises(TeamsAccessGatedError) as exc_info:
        await adapter.acquire(SESSION_ID)
    assert exc_info.value.meeting_id == MEETING_ID


JOIN_URL = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0"


@pytest.mark.asyncio
async def test_teams_adapter_acquire_resolves_join_url_to_user_and_meeting_id():
    """When capture_session_id is a raw join URL (the format detect_conferencing
    stores), the adapter resolves it to user_id:meeting_id via the Graph filter
    endpoint before fetching recordings and transcripts."""
    blob_store = InMemoryBlobStore()

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        # Resolution step: $filter by joinWebUrl
        if "onlineMeetings" in url and "%24filter" in url or "$filter" in url:
            return httpx.Response(
                200,
                json={
                    "value": [
                        {
                            "id": MEETING_ID,
                            "participants": {
                                "organizer": {
                                    "identity": {"user": {"id": USER_ID}}
                                }
                            },
                        }
                    ]
                },
            )
        # After resolution, falls through to the same Graph calls as the composite ID path
        if url == f"{BASE}/recordings":
            return httpx.Response(200, json=RECORDINGS)
        if url == f"{BASE}/recordings/r1/content":
            return httpx.Response(200, content=FAKE_MP4_BYTES)
        if url == f"{BASE}/transcripts":
            return httpx.Response(200, json=TRANSCRIPTS)
        if url == f"{BASE}/transcripts/t1/content":
            return httpx.Response(200, text=SAMPLE_VTT)
        raise AssertionError(f"unexpected request: {request.method} {url}")

    adapter = TeamsAdapter(
        token_provider=StaticTokenProvider("test-token"),
        blob_store=blob_store,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )

    artifacts = await adapter.acquire(JOIN_URL)

    assert artifacts.mode == CaptureMode.OFFICIAL_ARTIFACTS
    assert len(artifacts.audio_tracks) == 1
    assert {r.display_name for r in artifacts.roster} == {"Alice Chen", "Bob Fernando"}


@pytest.mark.asyncio
async def test_teams_adapter_no_recordings_or_transcripts_yields_empty_artifacts():
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == f"{BASE}/recordings":
            return httpx.Response(200, json={"value": []})
        if url == f"{BASE}/transcripts":
            return httpx.Response(200, json={"value": []})
        raise AssertionError(f"unexpected request: {request.method} {url}")

    adapter = TeamsAdapter(
        token_provider=StaticTokenProvider("test-token"),
        blob_store=InMemoryBlobStore(),
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )

    artifacts = await adapter.acquire(SESSION_ID)

    assert artifacts.audio_tracks == []
    assert artifacts.roster == []
    assert artifacts.speaker_labels == []
