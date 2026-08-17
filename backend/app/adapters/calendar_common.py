"""Conferencing-link detection shared by every calendar adapter.

A single place that knows what a Zoom/Meet/Teams link looks like, so
calendar_google.py and calendar_microsoft.py never duplicate this regex work
-- they just hand their event's location/description text here.
"""

import re

# Zoom: only numeric meeting-id links are usable -- our ZoomAdapter
# (app/capture/zoom_adapter.py) needs the numeric id to call the Cloud
# Recording API. Vanity URLs (zoom.us/my/someone) can't be resolved to that
# id from the link alone, so they're deliberately not matched here.
ZOOM_RE = re.compile(r"https?://[\w.-]*zoom\.us/j/(\d{9,11})(?:\?\S*)?", re.IGNORECASE)

# Google Meet: the standard 3-4-3 lowercase-letter room code.
MEET_RE = re.compile(r"https?://meet\.google\.com/([a-z]{3}-[a-z]{4}-[a-z]{3})", re.IGNORECASE)

# Teams classic meetup-join URL: the opaque thread id embedded here is NOT
# the Graph onlineMeeting id -- the whole URL is stored as platform_meeting_id
# and resolved to the meeting id later via GET /me/onlineMeetings?$filter=...
TEAMS_RE = re.compile(r"https?://teams\.(?:microsoft|live)\.com/l/meetup-join/[^\s\"'<>]+", re.IGNORECASE)

# Teams new-style short meeting links (introduced ~2024):
#   https://teams.microsoft.com/meet/<code>?p=<password>
# Same bot-join semantics -- the full URL is what the joiner navigates to.
TEAMS_SHORT_RE = re.compile(
    r"https?://teams\.(?:microsoft|live)\.com/meet/[a-zA-Z0-9]+(?:\?[^\s\"'<>]*)?",
    re.IGNORECASE,
)

# Google Meet shortlinks (g.co/meet/<code> redirects to meet.google.com/<code>).
# The room code embedded in both URL forms is identical, so we extract and
# store the code the same way MEET_RE does -- bot_join_url() reconstructs the
# canonical meet.google.com URL from it.
MEET_SHORT_RE = re.compile(
    r"https?://g\.co/meet/([a-z]{3}-[a-z]{4}-[a-z]{3})",
    re.IGNORECASE,
)

_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("zoom", ZOOM_RE),
    ("meet", MEET_RE),
    ("meet", MEET_SHORT_RE),
    ("teams", TEAMS_RE),
    ("teams", TEAMS_SHORT_RE),
]

# Platforms a Mode B bot can join (app/bot/runner.py). Zoom is deliberately
# excluded: RTMS (Mode A1) is its primary path, tied to the host's Zoom
# account rather than any calendar entry or manual trigger, so a web bot is
# only ever an explicit fallback for Zoom, never dispatched automatically.
# Shared by app/orchestrator/scheduler.py (calendar-driven) and
# app/api/capture.py (instant/no-calendar) so both dispatch paths agree on
# which platforms get a bot without duplicating the set.
BOT_ELIGIBLE_PLATFORMS = {"meet", "teams"}


def detect_conferencing(text: str) -> tuple[str, str] | None:
    """Returns (platform, platform_meeting_id) for the first recognized
    conferencing link in `text`, or None if none found. Checked in a fixed
    order so text mentioning multiple platforms (e.g. a forwarded invite)
    resolves deterministically rather than depending on match order luck.
    Works equally well on a raw pasted URL (app/api/capture.py's instant-
    capture endpoint) since this is a plain regex search, not something
    that requires calendar-event structure."""
    if not text:
        return None
    for platform, pattern in _PATTERNS:
        match = pattern.search(text)
        if match:
            meeting_id = match.group(1) if pattern.groups else match.group(0)
            return platform, meeting_id
    return None


def bot_join_url(platform: str, platform_meeting_id: str) -> str | None:
    """Reconstructs the URL a Mode B bot (app/bot/runner.py) actually
    navigates to, from detect_conferencing's platform_meeting_id -- shared
    by the calendar scheduler (app/orchestrator/scheduler.py) and the
    instant-capture endpoint (app/api/capture.py) so both dispatch paths
    build the same join URL the same way. Zoom is excluded: RTMS (Mode A1)
    is Zoom's primary path and a web bot is only an explicit fallback, not
    something either caller dispatches automatically -- see docs/03-capture.md."""
    if platform == "meet":
        return f"https://meet.google.com/{platform_meeting_id}"
    if platform == "teams":
        return platform_meeting_id  # already the full meetup-join URL
    return None
