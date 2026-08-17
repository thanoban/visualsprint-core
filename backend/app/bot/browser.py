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

    async def launch(self, *, display_name: str) -> None:
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
            ],
        )
        self.context = await self.browser.new_context(
            permissions=["microphone", "camera"],
            user_agent=(
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
            ),
        )
        self.page = await self.context.new_page()
        log.info("bot.browser.launched", display_name=display_name)

    async def close(self) -> None:
        try:
            if self.context is not None:
                await self.context.close()
            if self.browser is not None:
                await self.browser.close()
        finally:
            if self._playwright is not None:
                await self._playwright.stop()
