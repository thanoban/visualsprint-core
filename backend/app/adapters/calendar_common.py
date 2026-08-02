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

# Teams: unlike Zoom/Meet, the opaque thread id embedded in a meetup-join URL
# is NOT the same as the Graph onlineMeeting id. The correct real-world
# resolution path is GET /me/onlineMeetings?$filter=JoinWebUrl eq '<url>' --
# so the whole join URL is what our Teams adapter actually needs, and is
# what's stored as platform_meeting_id, not a substring parsed out of it.
TEAMS_RE = re.compile(r"https?://teams\.(?:microsoft|live)\.com/l/meetup-join/[^\s\"'<>]+", re.IGNORECASE)

_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("zoom", ZOOM_RE),
    ("meet", MEET_RE),
    ("teams", TEAMS_RE),
]


def detect_conferencing(text: str) -> tuple[str, str] | None:
    """Returns (platform, platform_meeting_id) for the first recognized
    conferencing link in `text`, or None if none found. Checked in a fixed
    order so text mentioning multiple platforms (e.g. a forwarded invite)
    resolves deterministically rather than depending on match order luck."""
    if not text:
        return None
    for platform, pattern in _PATTERNS:
        match = pattern.search(text)
        if match:
            meeting_id = match.group(1) if pattern.groups else match.group(0)
            return platform, meeting_id
    return None
