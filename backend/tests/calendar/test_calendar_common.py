"""Conferencing-link detection — the piece every calendar adapter shares."""

from app.adapters.calendar_common import detect_conferencing


def test_detects_zoom_numeric_link():
    result = detect_conferencing("Join: https://acme.zoom.us/j/1234567890?pwd=abc123")
    assert result == ("zoom", "1234567890")


def test_ignores_zoom_vanity_link():
    """Vanity URLs can't be resolved to the numeric id our ZoomAdapter needs."""
    assert detect_conferencing("https://zoom.us/my/nimal.perera") is None


def test_detects_meet_link():
    result = detect_conferencing("Video call link: https://meet.google.com/abc-defg-hij")
    assert result == ("meet", "abc-defg-hij")


def test_detects_teams_link_returns_whole_join_url():
    text = "Join on your computer: https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0"
    platform, meeting_id = detect_conferencing(text)
    assert platform == "teams"
    assert meeting_id.startswith("https://teams.microsoft.com/l/meetup-join/")


def test_no_conferencing_link_returns_none():
    assert detect_conferencing("Standup notes: nothing scheduled here.") is None


def test_empty_text_returns_none():
    assert detect_conferencing("") is None


def test_picks_zoom_first_when_multiple_platforms_mentioned():
    text = (
        "Primary: https://acme.zoom.us/j/1234567890 "
        "Backup: https://meet.google.com/abc-defg-hij"
    )
    platform, _ = detect_conferencing(text)
    assert platform == "zoom"
