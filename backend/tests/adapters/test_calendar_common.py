import pytest

from app.adapters.calendar_common import bot_join_url, detect_conferencing


@pytest.mark.parametrize(
    "text, expected_platform, expected_id_fragment",
    [
        # Classic Zoom numeric-id links
        ("https://us02web.zoom.us/j/123456789", "zoom", "123456789"),
        ("https://zoom.us/j/12345678901?pwd=abc", "zoom", "12345678901"),
        # Meet canonical
        ("https://meet.google.com/abc-defg-hij", "meet", "abc-defg-hij"),
        ("Join: https://meet.google.com/xyz-qrst-uvw and bring notes", "meet", "xyz-qrst-uvw"),
        # Meet shortlink (g.co/meet/<code>) — should extract the same room code
        ("https://g.co/meet/abc-defg-hij", "meet", "abc-defg-hij"),
        # Teams classic meetup-join URL
        (
            "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d",
            "teams",
            "https://teams.microsoft.com/l/meetup-join/",
        ),
        # Teams live.com variant
        (
            "https://teams.live.com/l/meetup-join/19%3ameeting_xyz%40thread.v2/0",
            "teams",
            "https://teams.live.com/l/meetup-join/",
        ),
        # Teams new short-form /meet/ link (microsoft.com)
        ("https://teams.microsoft.com/meet/abc123?p=secret", "teams", "https://teams.microsoft.com/meet/abc123"),
        # Teams new short-form /meet/ link (live.com / Teams Free)
        ("https://teams.live.com/meet/XyZ789", "teams", "https://teams.live.com/meet/XyZ789"),
    ],
)
def test_detect_conferencing_recognizes_all_link_formats(text, expected_platform, expected_id_fragment):
    result = detect_conferencing(text)
    assert result is not None, f"expected a match for {text!r}"
    platform, meeting_id = result
    assert platform == expected_platform
    assert expected_id_fragment in meeting_id


@pytest.mark.parametrize(
    "text",
    [
        "https://zoom.us/my/vanityname",         # vanity URL, no numeric id
        "https://example.com/meeting/123",        # unrecognized
        "",
        "join us on a call",
    ],
)
def test_detect_conferencing_rejects_non_matching_text(text):
    assert detect_conferencing(text) is None


def test_detect_conferencing_meet_short_yields_same_room_code_as_canonical():
    short = detect_conferencing("https://g.co/meet/abc-defg-hij")
    canonical = detect_conferencing("https://meet.google.com/abc-defg-hij")
    assert short == canonical


def test_bot_join_url_meet_reconstructs_canonical_from_room_code():
    code = "abc-defg-hij"
    url = bot_join_url("meet", code)
    assert url == f"https://meet.google.com/{code}"


def test_bot_join_url_teams_returns_stored_url_unchanged():
    join = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0"
    assert bot_join_url("teams", join) == join


def test_bot_join_url_teams_short_link_returned_unchanged():
    short = "https://teams.microsoft.com/meet/abc123?p=secret"
    assert bot_join_url("teams", short) == short


def test_bot_join_url_zoom_returns_none():
    assert bot_join_url("zoom", "12345678901") is None
