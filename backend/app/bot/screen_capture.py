"""1fps screenshot loop over a bot's joined meeting page -- feeds the same
keyframe/OCR pipeline as Mode A2's video_uri (app/screen/), sourced from the
bot's own view of the meeting instead of a platform recording.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from collections.abc import AsyncIterator

import structlog

from app.interfaces.meeting_bot import ScreenFrame

log = structlog.get_logger()

# runner.py retains only perceptually distinct frames. Sampling every five
# seconds still notices a new slide promptly without continuously stressing a
# long-running Meet page.
_INTERVAL_S = 5.0


class PlaywrightScreenCapture:
    """BotScreenCapture backed by periodic Page.screenshot() calls."""

    def __init__(self, page) -> None:
        self._page = page
        self._queue: asyncio.Queue[ScreenFrame | None] = asyncio.Queue()
        self._task: asyncio.Task | None = None
        self._started_at = 0.0

    async def start(self) -> None:
        self._started_at = time.monotonic()
        self._task = asyncio.create_task(self._loop())
        log.info("bot.screen.started")

    async def _loop(self) -> None:
        # Screenshot timeout: generous enough for a heavy SPA page (Meet loads
        # a lot of JS on join) but short enough that a single stuck call can't
        # freeze the asyncio event loop and block poll_status() indefinitely.
        _SCREENSHOT_TIMEOUT_MS = 8_000
        consecutive_failures = 0
        while True:
            try:
                image_bytes = await self._page.screenshot(
                    type="jpeg", quality=60, timeout=_SCREENSHOT_TIMEOUT_MS
                )
                consecutive_failures = 0
                await self._queue.put(
                    ScreenFrame(
                        captured_at_s=time.monotonic() - self._started_at,
                        image_bytes=image_bytes,
                    )
                )
            except asyncio.CancelledError:
                return
            except Exception as exc:
                consecutive_failures += 1
                log.warning("bot.screen.frame_skipped", error=str(exc), consecutive=consecutive_failures)
                if consecutive_failures >= 10:
                    log.warning("bot.screen.loop_aborted", consecutive=consecutive_failures)
                    return
            await asyncio.sleep(_INTERVAL_S)

    async def frames(self) -> AsyncIterator[ScreenFrame]:
        while True:
            frame = await self._queue.get()
            if frame is None:
                return
            yield frame

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
        await self._queue.put(None)
