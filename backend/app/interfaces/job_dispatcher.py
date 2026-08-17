from typing import Protocol


class JobDispatcher(Protocol):
    """Dispatch a BotSession to run independently of the calling process."""

    async def dispatch(self, bot_session_id: str) -> None: ...

    def in_flight_count(self) -> int:
        """Active dispatches this instance is aware of.

        Used by the worker sweep to enforce bot_max_concurrent for local
        dispatch. Cloud Run Job dispatch returns 0 — Cloud Run manages
        concurrency at the job level, not here."""
        ...
