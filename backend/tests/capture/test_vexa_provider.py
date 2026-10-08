import json

import httpx
import pytest

from app.adapters.capture_vexa import VexaCaptureProvider
from app.capture.provider_probe import probe
from app.interfaces.capture_provider import (
    CaptureProviderError,
    CaptureReference,
    CaptureStatus,
    MeetingTarget,
)


def reference():
    return CaptureReference(provider="vexa", record_id="42", platform="google_meet",
                            native_meeting_id="abc-defg-hij")


def record(status="requested", **fields):
    return {"id": 42, "platform": "google_meet", "native_meeting_id": "abc-defg-hij",
            "status": status, **fields}


@pytest.mark.parametrize("url,platform,native", [
    ("https://meet.google.com/abc-defg-hij?authuser=1", "google_meet", "abc-defg-hij"),
    ("https://us02web.zoom.us/j/12345678901?pwd=secret", "zoom", "12345678901"),
    ("https://zoom.us/wc/join/12345678901?pwd=a%2Bb", "zoom", "12345678901"),
    ("https://teams.live.com/meet/1234567890123?p=secret", "teams", "1234567890123"),
    ("https://teams.cloud.microsoft/meet/1234567890123?p=secret", "teams", "1234567890123"),
    ("https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=x",
     "teams", "19:meeting_abc@thread.v2"),
])
def test_invitation_identity_preserves_passcodes(url, platform, native):
    target = MeetingTarget.from_url(url)
    assert target.platform == platform
    assert target.native_meeting_id == native
    assert target.meeting_url == url
    assert "secret" not in repr(target)


@pytest.mark.parametrize("url", [
    "https://meet.google.com.evil.test/abc-defg-hij",
    "https://evil.test/?url=https://meet.google.com/abc-defg-hij",
    "https://user:password@meet.google.com/abc-defg-hij",
    "https://meet.google.com:8080/abc-defg-hij",
    "https://meet.google.com/abc-defg-hij/extra",
    "https://zoom.us.evil.test/j/12345678901",
    "http://meet.google.com/abc-defg-hij",
    "https://teams.live.com/meet/abc",
    "https://teams.microsoft.com/l/meetup-join/19%3ameeting_..%2Fsecret%40thread.v2/0",
    "join https://meet.google.com/abc-defg-hij",
])
def test_rejects_spoofed_or_unsupported_links(url):
    with pytest.raises(ValueError):
        MeetingTarget.from_url(url)


@pytest.mark.asyncio
async def test_start_uses_actual_contract_and_does_not_claim_capture():
    def respond(request):
        assert request.method == "POST"
        assert request.url.path == "/bots"
        body = json.loads(request.content)
        assert body == {
            "platform": "google_meet", "native_meeting_id": "abc-defg-hij",
            "meeting_url": "https://meet.google.com/abc-defg-hij",
            "bot_name": "VisualSprint Notetaker", "language": "en",
            "transcribe_enabled": True, "recording_enabled": False,
        }
        return httpx.Response(201, json=record())
    async with httpx.AsyncClient(base_url="https://vexa.test",
                                 transport=httpx.MockTransport(respond)) as client:
        result = await VexaCaptureProvider(client).start(
            MeetingTarget.from_url("https://meet.google.com/abc-defg-hij"))
    assert result.status == CaptureStatus.JOINING
    assert result.reference.record_id == "42"


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["timeout", "server", "invalid_json", "missing_id"])
async def test_ambiguous_dispatch_is_not_retried_and_never_leaks_body(failure):
    calls = []
    def respond(request):
        calls.append(request)
        if failure == "timeout":
            raise httpx.ReadTimeout("secret-key and meeting passcode", request=request)
        if failure == "server":
            return httpx.Response(503, text="secret-key and meeting passcode")
        if failure == "invalid_json":
            return httpx.Response(201, text="secret-key and meeting passcode")
        return httpx.Response(201, json={"status": "requested"})
    async with httpx.AsyncClient(base_url="https://vexa.test",
                                 transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(CaptureProviderError) as raised:
            await VexaCaptureProvider(client).start(
                MeetingTarget.from_url("https://meet.google.com/abc-defg-hij"))
    assert raised.value.uncertain
    assert not raised.value.retryable
    assert "secret" not in str(raised.value)
    assert len(calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("status,expected", [
    ("requested", CaptureStatus.JOINING), ("awaiting_admission", CaptureStatus.WAITING),
    ("needs_help", CaptureStatus.BLOCKED), ("active", CaptureStatus.CAPTURING),
    ("completed", CaptureStatus.ENDED), ("future_state", CaptureStatus.UNKNOWN),
])
async def test_status_uses_record_id_and_normalizes_without_guessing(status, expected):
    def respond(request):
        assert request.url.path == "/meetings/42"
        return httpx.Response(200, json=record(status))
    async with httpx.AsyncClient(base_url="https://vexa.test",
                                 transport=httpx.MockTransport(respond)) as client:
        snapshot = await VexaCaptureProvider(client).status(reference())
    assert snapshot.status == expected


@pytest.mark.asyncio
async def test_transcript_revisions_keep_final_and_unknown_speaker():
    def respond(request):
        assert request.url.path == "/transcripts/by-id/42"
        base = {"segment_id": "s1", "start": 10, "end": 12, "speaker": ""}
        return httpx.Response(200, json=record("completed", segments=[
            {**base, "text": "final decision", "completed": True},
            {**base, "text": "old draft", "completed": False},
        ]))
    async with httpx.AsyncClient(base_url="https://vexa.test",
                                 transport=httpx.MockTransport(respond)) as client:
        snapshot = await VexaCaptureProvider(client).transcript(reference())
    assert len(snapshot.segments) == 1
    assert snapshot.segments[0].text == "final decision"
    assert snapshot.segments[0].speaker_label is None
    assert snapshot.segments[0].confidence is None


@pytest.mark.asyncio
async def test_malformed_timestamps_fail_instead_of_compacting_the_timeline():
    async with httpx.AsyncClient(base_url="https://vexa.test", transport=httpx.MockTransport(
        lambda _: httpx.Response(200, json=record("completed", segments=[
            {"segment_id": "s1", "start": 9, "end": 2, "text": "invalid"}]))
    )) as client:
        with pytest.raises(CaptureProviderError, match="invalid_transcript"):
            await VexaCaptureProvider(client).transcript(reference())


@pytest.mark.asyncio
async def test_stop_completed_occurrence_cannot_stop_a_new_occurrence():
    calls = []
    def respond(request):
        calls.append(request.method)
        return httpx.Response(200, json=record("completed"))
    async with httpx.AsyncClient(base_url="https://vexa.test",
                                 transport=httpx.MockTransport(respond)) as client:
        await VexaCaptureProvider(client).stop(reference())
    assert calls == ["GET"]


@pytest.mark.asyncio
async def test_record_mismatch_refuses_stop():
    async with httpx.AsyncClient(base_url="https://vexa.test", transport=httpx.MockTransport(
        lambda _: httpx.Response(200, json=record("active", id=43))
    )) as client:
        with pytest.raises(CaptureProviderError, match="record_mismatch"):
            await VexaCaptureProvider(client).stop(reference())


@pytest.mark.asyncio
async def test_delete_artifacts_uses_record_id_and_requires_terminal():
    calls = []
    def respond(request):
        calls.append((request.method, request.url.path))
        return (httpx.Response(200, json=record("completed")) if request.method == "GET"
                else httpx.Response(204))
    async with httpx.AsyncClient(base_url="https://vexa.test",
                                 transport=httpx.MockTransport(respond)) as client:
        await VexaCaptureProvider(client).delete_artifacts(reference())
    assert calls == [("GET", "/meetings/42"), ("DELETE", "/meetings/42")]


@pytest.mark.asyncio
async def test_delete_never_cancels_a_scheduled_meeting():
    calls = []
    def respond(request):
        calls.append(request.method)
        return httpx.Response(200, json=record("scheduled"))
    async with httpx.AsyncClient(base_url="https://vexa.test",
                                 transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(CaptureProviderError, match="not_terminal"):
            await VexaCaptureProvider(client).delete_artifacts(reference())
    assert calls == ["GET"]


@pytest.mark.asyncio
async def test_credentials_are_not_forwarded_on_redirect():
    calls = []
    def respond(request):
        calls.append(request.url.host)
        return httpx.Response(302, headers={"location": "https://evil.test/bots"})
    async with httpx.AsyncClient(base_url="https://vexa.test", headers={"X-API-Key": "secret"},
                                 follow_redirects=True, transport=httpx.MockTransport(respond)) as c:
        with pytest.raises(CaptureProviderError):
            await VexaCaptureProvider(c).start(
                MeetingTarget.from_url("https://meet.google.com/abc-defg-hij"))
    assert calls == ["vexa.test"]


@pytest.mark.asyncio
async def test_read_only_probe_rejects_non_tls_remote_and_missing_key():
    assert not (await probe("http://remote.test", "secret"))["ok"]
    assert not (await probe("https://vexa.test", ""))["ok"]


@pytest.mark.asyncio
@pytest.mark.parametrize("url", [
    "https://us02web.zoom.us/j/12345678901?pwd=encrypted-token",
    "https://teams.live.com/meet/1234567890123?p=team-code",
    "https://meet.google.com/abc-defg-hij",
])
async def test_three_platform_spawn_keeps_invitation_and_required_identity(url):
    target = MeetingTarget.from_url(url)
    def respond(request):
        payload = json.loads(request.content)
        assert payload["platform"] == target.platform
        assert payload["native_meeting_id"] == target.native_meeting_id
        assert payload["meeting_url"] == url
        assert payload["recording_enabled"] is False
        if target.platform == "teams":
            assert payload["passcode"] == "team-code"
        else:
            assert "passcode" not in payload
        return httpx.Response(201, json={"id": 42, "platform": target.platform,
            "native_meeting_id": target.native_meeting_id, "status": "requested"})
    async with httpx.AsyncClient(base_url="https://vexa.test", transport=httpx.MockTransport(respond)) as client:
        assert (await VexaCaptureProvider(client).start(target)).status == CaptureStatus.JOINING
