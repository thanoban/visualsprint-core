"""Tests for the deterministic capture route decision (app/capture/routing.py).

The routing function is pure — it depends only on its parameters, not on any
external service or config. Every branch must be exercised to ensure the
capture mode displayed to the founder matches actual behaviour.
"""

from app.capture.routing import CaptureRoute, instant_route


def test_zoom_with_rtms_connection_routes_to_a1():
    route = instant_route("zoom", zoom_connected=True, bot_dispatch=True,
                          meet_guest=True, teams_guest=True)
    assert route.mode == "A1"
    assert "RTMS" in route.reason


def test_zoom_without_rtms_connection_falls_through_to_companion():
    route = instant_route("zoom", zoom_connected=False, bot_dispatch=True,
                          meet_guest=True, teams_guest=True)
    assert route.mode == "C"


def test_meet_with_guest_bot_enabled_routes_to_b():
    route = instant_route("meet", zoom_connected=False, bot_dispatch=True,
                          meet_guest=True, teams_guest=False)
    assert route.mode == "B"
    assert "bot" in route.reason.lower()


def test_meet_without_guest_bot_routes_to_companion():
    route = instant_route("meet", zoom_connected=False, bot_dispatch=True,
                          meet_guest=False, teams_guest=False)
    assert route.mode == "C"


def test_teams_with_guest_bot_enabled_routes_to_b():
    route = instant_route("teams", zoom_connected=False, bot_dispatch=True,
                          meet_guest=False, teams_guest=True)
    assert route.mode == "B"


def test_teams_without_bot_dispatch_routes_to_companion():
    route = instant_route("teams", zoom_connected=False, bot_dispatch=False,
                          meet_guest=False, teams_guest=True)
    assert route.mode == "C"


def test_unknown_platform_always_routes_to_companion():
    route = instant_route("webex", zoom_connected=False, bot_dispatch=True,
                          meet_guest=True, teams_guest=True)
    assert route.mode == "C"


def test_route_is_immutable():
    route = instant_route("meet", zoom_connected=False, bot_dispatch=False,
                          meet_guest=False, teams_guest=False)
    assert isinstance(route, CaptureRoute)
    import dataclasses
    assert dataclasses.is_dataclass(route)
    # frozen=True means attribute assignment raises FrozenInstanceError
    try:
        route.mode = "X"  # type: ignore[misc]
        assert False, "expected FrozenInstanceError"
    except Exception:
        pass
