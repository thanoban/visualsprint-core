"""Microsoft Teams guest-bot join (docs/03-capture.md Mode B). Uses the
Teams web client (join a meeting from the browser, no desktop app), typing a
display name and joining without an account. Since 13 Mar 2026, Teams labels
third-party bots "Unverified" in the lobby and requires an organizer to
explicitly admit them -- LOBBY_TIMEOUT (checked by app/bot/runner.py) is the
expected outcome when nobody clicks admit, not a bug to work around.
"""

from __future__ import annotations

import structlog

from app.bot.browser import PlaywrightSession
from app.interfaces.meeting_bot import BotRosterEntry, JoinOutcome

log = structlog.get_logger()

_JOIN_TIMEOUT_MS = 20_000


class TeamsJoiner:
    platform = "teams"

    def __init__(self) -> None:
        self._session = PlaywrightSession()
        self._display_name = "VisualSprint Notetaker"
        self._state = JoinOutcome.FAILED

    @property
    def page(self):
        return self._session.page

    async def join(
        self, join_url: str, *, display_name: str = "VisualSprint Notetaker"
    ) -> JoinOutcome:
        self._display_name = display_name
        await self._session.launch(display_name=display_name)
        page = self._session.page
        try:
            await page.goto(join_url, timeout=_JOIN_TIMEOUT_MS, wait_until="domcontentloaded")

            continue_browser = page.get_by_text("Continue on this browser", exact=False)
            if await continue_browser.count() > 0:
                await continue_browser.click()

            name_input = page.get_by_placeholder("Type your name")
            if await name_input.count() == 0:
                name_input = page.get_by_label("Type your name")
            if await name_input.count() > 0:
                await name_input.fill(display_name)

            for label in ("Mic", "Camera"):
                toggle = page.get_by_label(f"{label} off")
                # Teams sometimes starts these already off -- only click when
                # the current label indicates they're on.
                on_toggle = page.get_by_label(f"{label} on")
                if await on_toggle.count() > 0:
                    try:
                        await on_toggle.click(timeout=2000)
                    except Exception:
                        pass
                elif await toggle.count() == 0:
                    pass

            join_btn = page.get_by_text("Join now", exact=False)
            if await join_btn.count() == 0:
                self._state = JoinOutcome.FAILED
                return self._state
            await join_btn.click()

            lobby_text = page.get_by_text("Someone will let you in", exact=False)
            try:
                await lobby_text.wait_for(timeout=5000)
                self._state = JoinOutcome.IN_LOBBY
            except Exception:
                self._state = JoinOutcome.LIVE
                await self._announce(page)
            return self._state
        except Exception as exc:
            log.warning("bot.teams.join_failed", error=str(exc))
            self._state = JoinOutcome.FAILED
            return self._state

    async def _announce(self, page) -> None:
        try:
            chat_btn = page.get_by_label("Chat")
            if await chat_btn.count() > 0:
                await chat_btn.click(timeout=2000)
                box = page.get_by_label("Type a message")
                if await box.count() > 0:
                    await box.fill(
                        f"{self._display_name} is recording this meeting for VisualSprint "
                        "meeting notes."
                    )
                    await box.press("Enter")
        except Exception as exc:
            log.warning("bot.teams.announce_failed", error=str(exc))

    async def poll_status(self) -> JoinOutcome:
        page = self._session.page
        if page is None or page.is_closed():
            return JoinOutcome.FAILED
        try:
            if self._state == JoinOutcome.IN_LOBBY:
                leave_btn = page.get_by_label("Leave")
                if await leave_btn.count() > 0:
                    self._state = JoinOutcome.LIVE
                    await self._announce(page)
                    return self._state
                denied = page.get_by_text("declined", exact=False)
                if await denied.count() > 0:
                    self._state = JoinOutcome.DENIED
                    return self._state
            elif self._state == JoinOutcome.LIVE:
                ended = page.get_by_text("call has ended", exact=False)
                if await ended.count() > 0:
                    self._state = JoinOutcome.ENDED
            return self._state
        except Exception as exc:
            log.warning("bot.teams.poll_failed", error=str(exc))
            return self._state

    async def roster(self) -> list[BotRosterEntry]:
        page = self._session.page
        if page is None:
            return []
        try:
            people_btn = page.get_by_label("People")
            if await people_btn.count() > 0:
                await people_btn.click(timeout=2000)
            names = await page.locator("[data-tid='participantsInCall'] [data-tid='ts-video-tile-name']").all_inner_texts()
            return [BotRosterEntry(display_name=n.strip()) for n in names if n.strip()]
        except Exception as exc:
            log.warning("bot.teams.roster_failed", error=str(exc))
            return []

    async def leave(self) -> None:
        await self._session.close()
