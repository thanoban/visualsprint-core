"""Google Meet guest-bot join (docs/03-capture.md Mode B). Best-effort
against Meet's guest-join UI: enter a display name, force mic/camera off
inside the app so the bot never transmits its own audio, and click "Ask to
join" (or "Join now" when no lobby is configured). Selectors are text/label
based where possible -- Meet's DOM classes are obfuscated and change without
notice, but visible button text and aria-labels are comparatively stable.
"""

from __future__ import annotations

import structlog

from app.bot.browser import PlaywrightSession
from app.interfaces.meeting_bot import BotRosterEntry, JoinOutcome

log = structlog.get_logger()

_JOIN_TIMEOUT_MS = 20_000


class GoogleMeetJoiner:
    platform = "meet"  # matches Meeting.platform / detect_conferencing's "meet"

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

            name_input = page.get_by_placeholder("Your name")
            if await name_input.count() > 0:
                await name_input.fill(display_name)

            for label in ("Turn off microphone", "Turn off camera"):
                btn = page.get_by_label(label)
                if await btn.count() > 0:
                    try:
                        await btn.click(timeout=2000)
                    except Exception:
                        pass

            join_btn = page.get_by_text("Join now", exact=False)
            ask_btn = page.get_by_text("Ask to join", exact=False)
            if await join_btn.count() > 0:
                await join_btn.click()
                self._state = JoinOutcome.LIVE
            elif await ask_btn.count() > 0:
                await ask_btn.click()
                self._state = JoinOutcome.IN_LOBBY
            else:
                self._state = JoinOutcome.FAILED
                return self._state

            if self._state == JoinOutcome.LIVE:
                await self._announce(page)
            return self._state
        except Exception as exc:
            log.warning("bot.meet.join_failed", error=str(exc))
            self._state = JoinOutcome.FAILED
            return self._state

    async def _announce(self, page) -> None:
        try:
            chat_btn = page.get_by_label("Chat with everyone")
            if await chat_btn.count() > 0:
                await chat_btn.click(timeout=2000)
                box = page.get_by_placeholder("Send a message")
                if await box.count() > 0:
                    await box.fill(
                        f"{self._display_name} is recording this meeting for VisualSprint "
                        "meeting notes."
                    )
                    await box.press("Enter")
        except Exception as exc:
            log.warning("bot.meet.announce_failed", error=str(exc))

    async def poll_status(self) -> JoinOutcome:
        page = self._session.page
        if page is None or page.is_closed():
            return JoinOutcome.FAILED
        try:
            if self._state == JoinOutcome.IN_LOBBY:
                people_btn = page.get_by_label("People")
                if await people_btn.count() > 0:
                    self._state = JoinOutcome.LIVE
                    await self._announce(page)
                    return self._state
                removed = page.get_by_text("removed you", exact=False)
                denied = page.get_by_text("wasn't approved", exact=False)
                if await removed.count() > 0 or await denied.count() > 0:
                    self._state = JoinOutcome.DENIED
                    return self._state
            elif self._state == JoinOutcome.LIVE:
                ended = page.get_by_text("You left the meeting", exact=False)
                if await ended.count() > 0:
                    self._state = JoinOutcome.ENDED
            return self._state
        except Exception as exc:
            log.warning("bot.meet.poll_failed", error=str(exc))
            return self._state

    async def roster(self) -> list[BotRosterEntry]:
        page = self._session.page
        if page is None:
            return []
        try:
            people_btn = page.get_by_label("People")
            if await people_btn.count() > 0:
                await people_btn.click(timeout=2000)
            names = await page.locator("[data-participant-id]").all_inner_texts()
            return [BotRosterEntry(display_name=n.strip()) for n in names if n.strip()]
        except Exception as exc:
            log.warning("bot.meet.roster_failed", error=str(exc))
            return []

    async def leave(self) -> None:
        await self._session.close()
