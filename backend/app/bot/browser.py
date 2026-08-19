"""Shared Playwright browser/page lifecycle for Mode B guest-bot joiners
(app/adapters/bot_*.py). Each platform's join/lobby/roster mechanics differ,
but launching a headless Chromium context with mic/camera permissions
auto-granted and a page ready to navigate is identical across all three --
this is the one place that setup lives so a platform adapter is only ever
the CSS-selector/click-sequence part.
"""

from __future__ import annotations

import structlog

log = structlog.get_logger()


class PlaywrightSession:
    """Owns one browser/context/page for the lifetime of one bot join."""

    def __init__(self) -> None:
        self._playwright = None
        self.browser = None
        self.context = None
        self.page = None

    async def launch(self, *, display_name: str, storage_state_path: str | None = None) -> None:
        """Launch a headless Chromium and open a page.

        `storage_state_path`, when given and present on disk, is a Playwright
        storage_state JSON (cookies + localStorage) for a signed-in account --
        the Meet joiner passes the bot's Google session here so it joins as a
        real logged-in user (app/adapters/bot_google_meet.py). A missing or
        unreadable file is not fatal: the context launches anonymous and the
        joiner degrades to guest-join, so a lost/expired session never stops
        the bot from starting -- it just fails the join honestly (with a
        screenshot) if the meeting forbids anonymous users."""
        import os

        from playwright.async_api import async_playwright

        self._playwright = await async_playwright().start()
        self.browser = await self._playwright.chromium.launch(
            headless=True,
            args=[
                # Required in Docker/Cloud Run: Chrome cannot create a sandbox
                # when running as root (the default in Cloud Run containers).
                # Without --no-sandbox Chrome exits immediately with SIGILL/
                # signal 31 before the page even loads.
                "--no-sandbox",
                # Cloud Run allocates only 64 MB of /dev/shm by default; Chrome
                # uses it heavily for shared memory between renderer processes.
                # --disable-dev-shm-usage tells it to use /tmp instead, which
                # has no such limit.
                "--disable-dev-shm-usage",
                # Auto-accept the mic/camera permission prompt and hand back
                # a synthetic (silent) device -- the bot must never transmit
                # its own audio/video into the meeting, only receive.
                "--use-fake-ui-for-media-stream",
                "--use-fake-device-for-media-stream",
                # Force an English UI. Every Meet/Teams joiner selector is
                # text/aria-label based ("Your name", "Join now", "Ask to
                # join"); a container whose default locale isn't English would
                # render those labels translated and break every selector,
                # which is indistinguishable from a "DOM changed" failure.
                "--lang=en-US",
            ],
        )
        context_kwargs = dict(
            permissions=["microphone", "camera"],
            locale="en-US",
            user_agent=(
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
            ),
        )
        signed_in = False
        if storage_state_path and os.path.exists(storage_state_path):
            context_kwargs["storage_state"] = storage_state_path
            signed_in = True
        elif storage_state_path:
            log.warning("bot.browser.storage_state_missing", path=storage_state_path)

        try:
            self.context = await self.browser.new_context(**context_kwargs)
        except Exception as exc:
            # A corrupt/placeholder storage_state (e.g. before a real session
            # is captured) must never stop the bot from starting -- drop it and
            # launch anonymous, which still joins Workspace-hosted meetings and
            # fails others honestly (with a screenshot) rather than crashing.
            if signed_in:
                log.warning("bot.browser.storage_state_invalid", error=str(exc))
                context_kwargs.pop("storage_state", None)
                signed_in = False
                self.context = await self.browser.new_context(**context_kwargs)
            else:
                raise
        self.page = await self.context.new_page()
        log.info("bot.browser.launched", display_name=display_name, signed_in=signed_in)

    async def close(self) -> None:
        try:
            if self.context is not None:
                await self.context.close()
            if self.browser is not None:
                await self.browser.close()
        finally:
            if self._playwright is not None:
                await self._playwright.stop()
