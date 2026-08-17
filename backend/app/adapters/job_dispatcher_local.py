"""Local (in-process asyncio task) dispatcher — used in dev and tests.

Each dispatch creates an asyncio task for run_bot_session; tasks are tracked
in an internal set so in_flight_count() reports the correct number and the
worker sweep can honour bot_max_concurrent without exceeding it.
"""

import asyncio

import structlog

log = structlog.get_logger()


class LocalJobDispatcher:
    def __init__(self) -> None:
        self._tasks: set[asyncio.Task] = set()

    def in_flight_count(self) -> int:
        self._tasks = {t for t in self._tasks if not t.done()}
        return len(self._tasks)

    async def dispatch(self, bot_session_id: str) -> None:
        from app.bot.runner import run_bot_session

        task = asyncio.create_task(run_bot_session(bot_session_id))
        self._tasks.add(task)
        task.add_done_callback(lambda t: self._on_done(t, bot_session_id))
        log.info("bot_dispatch.local_task_created", bot_session_id=bot_session_id)

    def _on_done(self, task: asyncio.Task, bot_session_id: str) -> None:
        self._tasks.discard(task)
        if task.cancelled():
            log.warning("bot_dispatch.local_task_cancelled", bot_session_id=bot_session_id)
        elif task.exception() is not None:
            log.error(
                "bot_dispatch.local_task_failed",
                bot_session_id=bot_session_id,
                error=str(task.exception()),
            )
