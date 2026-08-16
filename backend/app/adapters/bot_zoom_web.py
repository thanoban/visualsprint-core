"""Zoom web-client guest-bot join -- fallback path only, used when an org
hasn't enabled RTMS (Mode A1, the primary and higher-quality Zoom path: see
docs/03-capture.md). Joins via web.zoom.us's browser client rather than
launching the desktop app, same "no bot in the room" preference the rest of
Mode B follows where a native API exists, applied to the one case where it
doesn't.
"""

from __future__ import annotations

import structlog

from app.bot.browser import PlaywrightSession
from app.interfaces.meeting_bot import BotRosterEntry, JoinOutcome

log = structlog.get_logger()

_JOIN_TIMEOUT_MS = 20_000


class ZoomWebJoiner:
    platform = "zoom"

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
            # Zoom's meeting URLs open an app-launch interstitial; the web
            # client lives at the same path with wc/join instead of j.
            web_url = join_url.replace("/j/", "/wc/join/")
            await page.goto(web_url, timeout=_JOIN_TIMEOUT_MS, wait_until="domcontentloaded")

            name_input = page.get_by_placeholder("Your Name")
            if await name_input.count() > 0:
                await name_input.fill(display_name)

            join_btn = page.get_by_text("Join", exact=True)
            if await join_btn.count() == 0:
                self._state = JoinOutcome.FAILED
                return self._state
            await join_btn.click()

            waiting = page.get_by_text("Please wait for the host", exact=False)
            try:
                await waiting.wait_for(timeout=5000)
                self._state = JoinOutcome.IN_LOBBY
            except Exception:
                self._state = JoinOutcome.LIVE
                await self._announce(page)
            return self._state
        except Exception as exc:
            log.warning("bot.zoom_web.join_failed", error=str(exc))
            self._state = JoinOutcome.FAILED
            return self._state

    async def _announce(self, page) -> None:
        try:
            chat_btn = page.get_by_label("open the chat panel")
            if await chat_btn.count() > 0:
                await chat_btn.click(timeout=2000)
                box = page.get_by_placeholder("Type message here")
                if await box.count() > 0:
                    await box.fill(
                        f"{self._display_name} is recording this meeting for VisualSprint "
                        "meeting notes."
                    )
                    await box.press("Enter")
        except Exception as exc:
            log.warning("bot.zoom_web.announce_failed", error=str(exc))

    async def poll_status(self) -> JoinOutcome:
        page = self._session.page
        if page is None or page.is_closed():
            return JoinOutcome.FAILED
        try:
            if self._state == JoinOutcome.IN_LOBBY:
                leave_btn = page.get_by_text("Leave", exact=False)
                if await leave_btn.count() > 0:
                    self._state = JoinOutcome.LIVE
                    await self._announce(page)
                    return self._state
            elif self._state == JoinOutcome.LIVE:
                ended = page.get_by_text("This meeting has been ended", exact=False)
                if await ended.count() > 0:
                    self._state = JoinOutcome.ENDED
            return self._state
        except Exception as exc:
            log.warning("bot.zoom_web.poll_failed", error=str(exc))
            return self._state

    async def roster(self) -> list[BotRosterEntry]:
        page = self._session.page
        if page is None:
            return []
        try:
            names = await page.locator(".participants-item__display-name").all_inner_texts()
            return [BotRosterEntry(display_name=n.strip()) for n in names if n.strip()]
        except Exception as exc:
            log.warning("bot.zoom_web.roster_failed", error=str(exc))
            return []

    async def leave(self) -> None:
        await self._session.close()
