"""Unit tests for GoogleMeetJoiner's detach-resilient interactions.

The production join failures were exactly this: Meet resolves the name input /
join button in the DOM, then re-renders and *detaches* the node mid-action, so
a single fill()/click() times out. These tests drive the retry helpers with a
fake Playwright locator that fails a few times (simulating detach) before
succeeding, proving the helper recovers -- and that it gives up cleanly when
the element never becomes usable, rather than hanging. No real browser.
"""

from __future__ import annotations

import pytest

from app.adapters.bot_google_meet import GoogleMeetJoiner


class FakeLocator:
    """Minimal stand-in for a Playwright locator. Raises for the first
    `fail_times` interactions (as a detached node would), then behaves."""

    def __init__(self, *, fail_times: int = 0, never_succeeds: bool = False) -> None:
        self._fail_times = fail_times
        self._never = never_succeeds
        self._calls = 0
        self._value = ""

    @property
    def first(self):
        return self

    async def wait_for(self, *, state: str, timeout: float) -> None:
        if self._never:
            raise RuntimeError("element was detached from the DOM")
        if self._calls < self._fail_times:
            self._calls += 1
            raise RuntimeError("element is not visible")

    async def click(self, *, timeout: float = 0) -> None:
        if self._never:
            raise RuntimeError("element was detached from the DOM")

    async def fill(self, text: str, *, timeout: float = 0) -> None:
        if self._never:
            raise RuntimeError("element was detached from the DOM")
        self._value = text

    async def input_value(self) -> str:
        return self._value


@pytest.fixture
def joiner() -> GoogleMeetJoiner:
    return GoogleMeetJoiner()


async def test_fill_recovers_after_transient_detach(joiner: GoogleMeetJoiner):
    loc = FakeLocator(fail_times=2)
    assert await joiner._fill_when_stable(loc, "VisualSprint Notetaker") is True
    assert await loc.input_value() == "VisualSprint Notetaker"


async def test_fill_gives_up_when_never_usable(joiner: GoogleMeetJoiner):
    loc = FakeLocator(never_succeeds=True)
    assert await joiner._fill_when_stable(loc, "VisualSprint Notetaker") is False


async def test_click_recovers_after_transient_detach(joiner: GoogleMeetJoiner):
    loc = FakeLocator(fail_times=3)
    assert await joiner._click_when_stable(loc) is True


async def test_click_gives_up_when_never_usable(joiner: GoogleMeetJoiner):
    loc = FakeLocator(never_succeeds=True)
    assert await joiner._click_when_stable(loc) is False
