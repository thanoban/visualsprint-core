"""1fps screenshot loop over a bot's joined meeting page -- feeds the same
keyframe/OCR pipeline as Mode A2's video_uri (app/screen/), sourced from the
bot's own view of the meeting instead of a platform recording.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator

import structlog

from app.interfaces.meeting_bot import ScreenFrame

log = structlog.get_logger()

_INTERVAL_S = 1.0


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
        try:
            while True:
                image_bytes = await self._page.screenshot(type="jpeg", quality=60)
                await self._queue.put(
                    ScreenFrame(
                        captured_at_s=time.monotonic() - self._started_at,
                        image_bytes=image_bytes,
                    )
                )
                await asyncio.sleep(_INTERVAL_S)
        except asyncio.CancelledError:
            return
        except Exception as exc:
            log.warning("bot.screen.loop_failed", error=str(exc))

    async def frames(self) -> AsyncIterator[ScreenFrame]:
        while True:
            frame = await self._queue.get()
            if frame is None:
                return
            yield frame

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        await self._queue.put(None)
