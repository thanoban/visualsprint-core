"""Capture policy is deterministic and independent of vendor adapters."""

from dataclasses import dataclass


@dataclass(frozen=True)
class CaptureRoute:
    mode: str
    reason: str


def instant_route(platform: str, *, zoom_connected: bool, bot_dispatch: bool,
                  meet_guest: bool, teams_guest: bool) -> CaptureRoute:
    if platform == "zoom" and zoom_connected:
        return CaptureRoute("A1", "Connected Zoom host; wait for confirmed RTMS stream events")
    if bot_dispatch and ((platform == "meet" and meet_guest) or (platform == "teams" and teams_guest)):
        return CaptureRoute("B", "Guest bot explicitly enabled; host admission is still required")
    return CaptureRoute("C", "Join in your browser and click the companion icon to capture")
