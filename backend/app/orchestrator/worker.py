"""Worker loop — claims jobs, dispatches to stage handlers, records outcomes.

Stage handlers are registered in a plain dict; each receives (db, job) and
must be idempotent. Handlers for later phases are stubs that no-op until the
phase is built — the walking skeleton runs end-to-end from day one.
"""

import asyncio
import traceback
from collections.abc import Awaitable, Callable

import structlog

from app.config import get_settings
from app.db.base import get_sessionmaker
from app.db.models import PipelineJob
from app.orchestrator import queue as q

log = structlog.get_logger()

StageHandler = Callable[[object, PipelineJob], Awaitable[None]]
_HANDLERS: dict[str, StageHandler] = {}


def stage_handler(name: str) -> Callable[[StageHandler], StageHandler]:
    def register(fn: StageHandler) -> StageHandler:
        _HANDLERS[name] = fn
        return fn

    return register


async def _noop(db: object, job: PipelineJob) -> None:  # placeholder for unbuilt phases
    log.info("stage.noop", stage=job.stage, session=job.capture_session_id)


async def run_once() -> bool:
    """Claim and run one job. Returns True if a job was processed."""
    Session = get_sessionmaker()
    with Session() as db:
        job = q.claim_next_job(db)
        if job is None:
            db.commit()
            return False
        handler = _HANDLERS.get(job.stage, _noop)
        try:
            await handler(db, job)
            q.complete_job(db, job)
            db.commit()
            log.info("stage.done", stage=job.stage, session=job.capture_session_id)
        except Exception as exc:
            db.rollback()
            with Session() as db2:
                job2 = db2.get(PipelineJob, job.id)
                if job2 is not None:
                    q.fail_job(db2, job2, f"{exc}\n{traceback.format_exc(limit=5)}")
                    db2.commit()
            log.error("stage.failed", stage=job.stage, error=str(exc))
        return True


async def main() -> None:
    settings = get_settings()
    log.info("worker.start", worker=q.WORKER_ID)
    reap_counter = 0
    while True:
        processed = await run_once()
        if not processed:
            await asyncio.sleep(settings.worker_poll_seconds)
        reap_counter += 1
        if reap_counter >= 100:
            reap_counter = 0
            Session = get_sessionmaker()
            with Session() as db:
                n = q.reap_stuck_jobs(db)
                db.commit()
                if n:
                    log.warning("worker.reaped", count=n)


if __name__ == "__main__":
    asyncio.run(main())
