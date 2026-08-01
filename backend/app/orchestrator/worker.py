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


_llm_client = None
_transcriber = None


def _get_llm():
    global _llm_client
    if _llm_client is None:
        from app.adapters.llm_vertex import VertexLlmClient

        _llm_client = VertexLlmClient()
    return _llm_client


def _get_transcriber():
    """Lazy singleton, same pattern as _get_llm — overridable in tests via
    `app.orchestrator.worker._transcriber = <fake>` so the walking-skeleton
    test never needs real Google/Azure/Groq credentials or torch/speechbrain."""
    global _transcriber
    if _transcriber is None:
        from app.asr.cascade import TranscriptionCascade

        _transcriber = TranscriptionCascade()
    return _transcriber


@stage_handler("acquire")
async def _handle_acquire(db: object, job: PipelineJob) -> None:
    """Mode D: audio already landed in blob storage at upload time (see
    api/upload.py) — this stage just confirms the audio_track row exists so a
    missing upload fails loudly here rather than silently at transcribe time.
    Other modes aren't wired to a PlatformAdapter yet; that is a later phase,
    and failing explicitly beats producing an empty session."""
    from sqlalchemy import select

    from app.db.models import AudioTrack, CaptureSession

    session = db.get(CaptureSession, job.capture_session_id)
    if session is None:
        raise RuntimeError(f"capture_session {job.capture_session_id} not found")

    has_track = db.execute(
        select(AudioTrack.id).where(AudioTrack.capture_session_id == session.id).limit(1)
    ).scalar_one_or_none()

    if session.mode == "D":
        if has_track is None:
            raise RuntimeError(
                "mode D session has no audio_track — upload endpoint should have written one"
            )
        return

    raise RuntimeError(
        f"acquire not yet implemented for mode {session.mode!r} — "
        "PlatformAdapter.acquire() integration lands in a later phase"
    )


@stage_handler("transcribe")
async def _handle_transcribe(db: object, job: PipelineJob) -> None:
    """Idempotent: clears any utterances from a prior partial attempt at this
    stage before re-inserting, so a crash-and-retry never duplicates rows."""
    from sqlalchemy import select

    from app.db.models import AudioTrack, CaptureSession, Utterance
    from app.interfaces.transcriber import TranscriptionRequest

    session = db.get(CaptureSession, job.capture_session_id)
    if session is None:
        raise RuntimeError(f"capture_session {job.capture_session_id} not found")

    tracks = (
        db.execute(select(AudioTrack).where(AudioTrack.capture_session_id == session.id))
        .scalars()
        .all()
    )
    if not tracks:
        raise RuntimeError("no audio_track to transcribe — acquire stage should have failed first")

    db.query(Utterance).filter(Utterance.capture_session_id == session.id).delete()

    transcriber = _get_transcriber()
    for track in tracks:
        result = await transcriber.transcribe(
            TranscriptionRequest(audio_uri=track.uri, org_id=session.org_id)
        )
        for seg in result.segments:
            db.add(
                Utterance(
                    org_id=session.org_id,
                    capture_session_id=session.id,
                    person_id=track.participant_person_id,
                    start_s=seg.start_s,
                    end_s=seg.end_s,
                    text=seg.text,
                    lang_tags=[lang.value for lang in seg.lang_tags],
                    asr_confidence=seg.asr_confidence,
                    # Zoom per-participant tracks carry exact identity; mixed
                    # tracks (Mode D/Meet/Teams) have no attribution yet —
                    # diarization/identity fusion lands with keyframes (Phase 3).
                    attribution_confidence=1.0 if track.participant_person_id else 0.0,
                    provider=seg.provider,
                )
            )
    db.flush()
    log.info("transcribe.done", session=session.id, tracks=len(tracks))


@stage_handler("understand")
async def _handle_understand(db: object, job: PipelineJob) -> None:
    from app.agents.context import run_context_intelligence

    await run_context_intelligence(db, job.capture_session_id, _get_llm())


@stage_handler("verify")
async def _handle_verify(db: object, job: PipelineJob) -> None:
    from app.agents.verification import run_evidence_verification

    await run_evidence_verification(db, job.capture_session_id, _get_llm())


@stage_handler("remember")
async def _handle_remember(db: object, job: PipelineJob) -> None:
    from app.agents.memory import run_memory_intelligence

    await run_memory_intelligence(db, job.capture_session_id, _get_llm())


@stage_handler("propose")
async def _handle_propose(db: object, job: PipelineJob) -> None:
    from app.agents.action import run_action_intelligence

    await run_action_intelligence(db, job.capture_session_id, _get_llm())


@stage_handler("report")
async def _handle_report(db: object, job: PipelineJob) -> None:
    from app.adapters.blobstore_s3 import get_blobstore
    from app.agents.report import run_report_intelligence

    await run_report_intelligence(db, job.capture_session_id, _get_llm(), blobstore=get_blobstore())


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
