"""Unit tests for TeamsJoiner's DOM-interaction logic.

TeamsJoiner had zero test coverage while its Meet and Zoom-web siblings did --
found during the RTMS/Teams/calendar capture audit. No real browser: a fake
Playwright Page/Locator drives join()/poll_status()/roster() through their
real branches (lobby vs. immediate admission, denial, end-of-call, roster
scraping), the same way test_google_meet_joiner.py fakes its own locators.
"""

from __future__ import annotations

import pytest

from app.adapters.bot_teams import TeamsJoiner
from app.interfaces.meeting_bot import JoinOutcome


class FakeLocator:
    """Minimal stand-in for a Playwright locator. `present=False` (the
    default) reproduces an element that simply doesn't exist on the page --
    `count()` is 0, and `wait_for` never resolves (matching Playwright's
    real timeout behavior for an absent element)."""

    def __init__(self, *, present: bool = True, wait_raises: bool = False) -> None:
        self.present = present
        self.wait_raises = wait_raises
        self.clicked = False
        self.filled_text: str | None = None
        self.pressed: list[str] = []

    async def count(self) -> int:
        return 1 if self.present else 0

    async def click(self, *, timeout: float = 0) -> None:
        if not self.present:
            raise RuntimeError("element not found")
        self.clicked = True

    async def fill(self, text: str, *, timeout: float = 0) -> None:
        self.filled_text = text

    async def wait_for(self, *, timeout: float = 0) -> None:
        if not self.present or self.wait_raises:
            raise TimeoutError("element did not appear")

    async def press(self, key: str) -> None:
        self.pressed.append(key)

    async def all_inner_texts(self) -> list[str]:
        return []


_ABSENT = FakeLocator(present=False)


class FakePage:
    """Registry-backed fake: only the elements a scenario cares about are
    registered; every other selector transparently resolves to an absent
    locator, matching how a real page behaves for elements not on screen."""

    def __init__(self, *, closed: bool = False) -> None:
        self.closed = closed
        self._by_text: dict[str, FakeLocator] = {}
        self._by_label: dict[str, FakeLocator] = {}
        self._by_placeholder: dict[str, FakeLocator] = {}
        self._roster_texts: list[str] = []
        self.goto_calls: list[str] = []

    def register_text(self, text: str, locator: FakeLocator) -> None:
        self._by_text[text] = locator

    def register_label(self, label: str, locator: FakeLocator) -> None:
        self._by_label[label] = locator

    def register_placeholder(self, placeholder: str, locator: FakeLocator) -> None:
        self._by_placeholder[placeholder] = locator

    def is_closed(self) -> bool:
        return self.closed

    async def goto(self, url: str, *, timeout: float = 0, wait_until: str = "") -> None:
        self.goto_calls.append(url)

    def get_by_text(self, text: str, *, exact: bool = False) -> FakeLocator:
        return self._by_text.get(text, _ABSENT)

    def get_by_label(self, label: str) -> FakeLocator:
        return self._by_label.get(label, _ABSENT)

    def get_by_placeholder(self, placeholder: str) -> FakeLocator:
        return self._by_placeholder.get(placeholder, _ABSENT)

    def locator(self, selector: str) -> _RosterLocator:
        return _RosterLocator(self._roster_texts)


class _RosterLocator:
    def __init__(self, texts: list[str]) -> None:
        self._texts = texts

    async def all_inner_texts(self) -> list[str]:
        return self._texts


async def _joiner_with_page(page: FakePage) -> TeamsJoiner:
    """Builds a TeamsJoiner whose session is pre-wired to a fake page,
    bypassing PlaywrightSession.launch()'s real headless Chromium launch.
    Sets page immediately (poll_status/roster read it directly, without ever
    calling launch()) and also on launch (join() calls launch() first)."""
    joiner = TeamsJoiner()
    joiner._session.page = page

    async def _fake_launch(*, display_name: str, storage_state_path: str | None = None) -> None:
        joiner._session.page = page

    joiner._session.launch = _fake_launch  # type: ignore[method-assign]
    return joiner


async def test_join_immediate_admission_announces_in_chat():
    page = FakePage()
    page.register_text("Join now", FakeLocator())
    # No lobby text registered -> absent -> wait_for raises -> LIVE branch
    chat_btn = FakeLocator()
    msg_box = FakeLocator()
    page.register_label("Chat", chat_btn)
    page.register_label("Type a message", msg_box)

    joiner = await _joiner_with_page(page)
    outcome = await joiner.join("https://teams.microsoft.com/l/meetup-join/abc")

    assert outcome == JoinOutcome.LIVE
    assert chat_btn.clicked is True
    assert "recording this meeting" in (msg_box.filled_text or "")
    assert msg_box.pressed == ["Enter"]


async def test_join_with_lobby_returns_in_lobby_without_announcing():
    page = FakePage()
    page.register_text("Join now", FakeLocator())
    page.register_text("Someone will let you in", FakeLocator())
    chat_btn = FakeLocator()
    page.register_label("Chat", chat_btn)

    joiner = await _joiner_with_page(page)
    outcome = await joiner.join("https://teams.microsoft.com/l/meetup-join/abc")

    assert outcome == JoinOutcome.IN_LOBBY
    assert chat_btn.clicked is False  # not announced while still waiting


async def test_join_fails_when_join_button_never_appears():
    page = FakePage()  # "Join now" never registered -> absent

    joiner = await _joiner_with_page(page)
    outcome = await joiner.join("https://teams.microsoft.com/l/meetup-join/abc")

    assert outcome == JoinOutcome.FAILED


async def test_join_propagates_launch_failure():
    """join()'s try/except starts AFTER _session.launch() -- a launch failure
    (e.g. headless Chromium failing to start) is not caught the way a
    goto/interaction failure is; it propagates to the caller uncaught. This
    documents that real, current behavior rather than asserting a graceful
    FAILED return the code doesn't actually produce here."""
    joiner = TeamsJoiner()

    async def _raise_launch(*, display_name: str, storage_state_path: str | None = None) -> None:
        raise RuntimeError("browser launch failed")

    joiner._session.launch = _raise_launch  # type: ignore[method-assign]
    with pytest.raises(RuntimeError, match="browser launch failed"):
        await joiner.join("https://teams.microsoft.com/l/meetup-join/abc")


async def test_poll_status_transitions_lobby_to_live_and_announces():
    page = FakePage()
    leave_btn = FakeLocator()
    chat_btn = FakeLocator()
    msg_box = FakeLocator()
    page.register_label("Leave", leave_btn)
    page.register_label("Chat", chat_btn)
    page.register_label("Type a message", msg_box)

    joiner = await _joiner_with_page(page)
    joiner._state = JoinOutcome.IN_LOBBY

    outcome = await joiner.poll_status()

    assert outcome == JoinOutcome.LIVE
    assert chat_btn.clicked is True


async def test_poll_status_detects_denial_from_lobby():
    page = FakePage()
    page.register_text("declined", FakeLocator())

    joiner = await _joiner_with_page(page)
    joiner._state = JoinOutcome.IN_LOBBY

    outcome = await joiner.poll_status()

    assert outcome == JoinOutcome.DENIED


async def test_poll_status_detects_call_ended_from_live():
    page = FakePage()
    page.register_text("call has ended", FakeLocator())

    joiner = await _joiner_with_page(page)
    joiner._state = JoinOutcome.LIVE

    outcome = await joiner.poll_status()

    assert outcome == JoinOutcome.ENDED


async def test_poll_status_returns_failed_when_page_missing():
    joiner = TeamsJoiner()
    joiner._session.page = None

    outcome = await joiner.poll_status()

    assert outcome == JoinOutcome.FAILED


async def test_roster_parses_and_filters_blank_names():
    page = FakePage()
    page.register_label("People", FakeLocator())
    page._roster_texts = ["Alice", "  ", "Bob  ", ""]

    joiner = await _joiner_with_page(page)
    joiner._session.page = page

    roster = await joiner.roster()

    assert [r.display_name for r in roster] == ["Alice", "Bob"]


async def test_roster_returns_empty_list_when_page_missing():
    joiner = TeamsJoiner()
    joiner._session.page = None

    roster = await joiner.roster()

    assert roster == []
