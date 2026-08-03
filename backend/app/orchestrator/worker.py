"""Worker loop — claims jobs, dispatches to stage handlers, records outcomes.

Stage handlers are registered in a plain dict; each receives (db, job) and
must be idempotent. Handlers for later phases are stubs that no-op until the
phase is built — the walking skeleton runs end-to-end from day one.
"""

import asyncio
import traceback
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

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
_platform_adapters = None
_calendar_adapters = None


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


_embedder = None


def _get_embedder():
    """Lazy singleton, same pattern as _get_transcriber — overridable in
    tests via `app.orchestrator.worker._embedder = <fake>`. Memory
    Intelligence treats a missing embedder as an optional enhancement, not a
    hard requirement, so this failing loudly (no Vertex credentials) only
    degrades `remember` to keyword-overlap search, never breaks the stage."""
    global _embedder
    if _embedder is None:
        from app.adapters.embedder_vertex import VertexEmbedder

        _embedder = VertexEmbedder()
    return _embedder


def _get_platform_adapters():
    """Production adapter registry for official artifact capture.

    Real OAuth providers are intentionally not configured yet. The adapters
    still sit behind the PlatformAdapter protocol, and tests override this
    registry with fakes so the worker contract stays credential-free.
    """
    global _platform_adapters
    if _platform_adapters is None:
        from app.adapters.blobstore_s3 import get_blobstore
        from app.capture.meet_adapter import MeetAdapter
        from app.capture.teams_adapter import TeamsAdapter
        from app.capture.token_provider import UnconfiguredTokenProvider
        from app.capture.zoom_adapter import ZoomAdapter

        blob_store = get_blobstore()
        _platform_adapters = {
            "meet": MeetAdapter(
                token_provider=UnconfiguredTokenProvider("Google Meet OAuth not configured"),
                blob_store=blob_store,
            ),
            "zoom": ZoomAdapter(
                token_provider=UnconfiguredTokenProvider("Zoom OAuth not configured"),
                blob_store=blob_store,
            ),
            "teams": TeamsAdapter(
                token_provider=UnconfiguredTokenProvider("Microsoft Graph OAuth not configured"),
                blob_store=blob_store,
            ),
        }
    return _platform_adapters


def _get_calendar_adapters():
    """Same maturity level as _get_platform_adapters: real OAuth isn't
    configured yet, so every CalendarConnection currently fails loudly when
    synced -- caught and logged per-connection in _sync_all_calendars, never
    crashes the worker or blocks other connections."""
    global _calendar_adapters
    if _calendar_adapters is None:
        from app.adapters.calendar_google import GoogleCalendarAdapter
        from app.adapters.calendar_microsoft import MicrosoftCalendarAdapter
        from app.capture.token_provider import UnconfiguredTokenProvider

        _calendar_adapters = {
            "google": GoogleCalendarAdapter(
                token_provider=UnconfiguredTokenProvider("Google Calendar OAuth not configured")
            ),
            "microsoft": MicrosoftCalendarAdapter(
                token_provider=UnconfiguredTokenProvider("Microsoft Graph OAuth not configured")
            ),
        }
    return _calendar_adapters


async def _sync_all_calendars(db: object) -> None:
    """One pass over every CalendarConnection (app/orchestrator/scheduler.py
    docstring: "not wired to a live cron yet... today it's invoked directly
    (ops script or test)" -- this is that periodic caller). A failure on one
    connection (bad/expired token, API outage) is logged and skipped, never
    stops the rest -- one org's broken calendar link must not silently
    starve every other org's meeting discovery."""
    from sqlalchemy import select

    from app.db.models import CalendarConnection
    from app.orchestrator.scheduler import sync_calendar_connection

    adapters = _get_calendar_adapters()
    connections = db.execute(select(CalendarConnection)).scalars().all()
    for connection in connections:
        adapter = adapters.get(connection.provider)
        if adapter is None:
            log.warning(
                "calendar_sync.unknown_provider", connection=connection.id, provider=connection.provider
            )
            continue
        try:
            created = await sync_calendar_connection(db, connection, adapter)
            db.commit()
            if created:
                log.info(
                    "calendar_sync.created_sessions", connection=connection.id, count=len(created)
                )
        except Exception as exc:
            db.rollback()
            log.warning("calendar_sync.failed", connection=connection.id, error=str(exc))


def _person_for_roster_entry(db: object, org_id: str, entry):
    from sqlalchemy import select

    from app.db.models import Person

    if entry.email:
        existing = db.execute(
            select(Person).where(Person.org_id == org_id, Person.email == entry.email).limit(1)
        ).scalar_one_or_none()
        if existing:
            return existing

    existing = db.execute(
        select(Person)
        .where(Person.org_id == org_id, Person.display_name == entry.display_name)
        .limit(1)
    ).scalar_one_or_none()
    if existing:
        if entry.email and not existing.email:
            existing.email = entry.email
        return existing

    person = Person(
        org_id=org_id,
        display_name=entry.display_name,
        email=entry.email,
        aliases=[entry.display_name],
    )
    db.add(person)
    db.flush()
    return person


def _persist_capture_artifacts(db: object, session, artifacts) -> None:
    from app.db.models import AudioTrack, Participant

    participant_by_key = {}
    for entry in artifacts.roster:
        person = _person_for_roster_entry(db, session.org_id, entry)
        participant = Participant(
            org_id=session.org_id,
            capture_session_id=session.id,
            person_id=person.id,
            display_name=entry.display_name,
            platform_user_id=entry.platform_user_id,
        )
        db.add(participant)
        for key in (entry.email, entry.platform_user_id, entry.display_name):
            if key:
                participant_by_key[key] = participant
    db.flush()

    for track in artifacts.audio_tracks:
        person_id = None
        display_name = None
        if track.participant:
            display_name = track.participant.display_name
            participant = next(
                (
                    participant_by_key[key]
                    for key in (
                        track.participant.email,
                        track.participant.platform_user_id,
                        track.participant.display_name,
                    )
                    if key and key in participant_by_key
                ),
                None,
            )
            if participant is None:
                person = _person_for_roster_entry(db, session.org_id, track.participant)
                participant = Participant(
                    org_id=session.org_id,
                    capture_session_id=session.id,
                    person_id=person.id,
                    display_name=track.participant.display_name,
                    platform_user_id=track.participant.platform_user_id,
                )
                db.add(participant)
                db.flush()
            person_id = participant.person_id

        db.add(
            AudioTrack(
                org_id=session.org_id,
                capture_session_id=session.id,
                uri=track.uri,
                participant_person_id=person_id,
                participant_display_name=display_name,
            )
        )

    session.video_uri = artifacts.screen_share_uri or artifacts.video_uri


@stage_handler("acquire")
async def _handle_acquire(db: object, job: PipelineJob) -> None:
    """Mode D: audio already landed in blob storage at upload time (see
    api/upload.py) — this stage just confirms the audio_track row exists so a
    missing upload fails loudly here rather than silently at transcribe time.
    Other modes aren't wired to a PlatformAdapter yet; that is a later phase,
    and failing explicitly beats producing an empty session."""
    from sqlalchemy import select

    from app.db.models import AudioTrack, CaptureSession, Participant

    session = db.get(CaptureSession, job.capture_session_id)
    if session is None:
        raise RuntimeError(f"capture_session {job.capture_session_id} not found")
    meeting = session.meeting

    has_track = db.execute(
        select(AudioTrack.id).where(AudioTrack.capture_session_id == session.id).limit(1)
    ).scalar_one_or_none()

    if session.mode == "D":
        if has_track is None:
            raise RuntimeError(
                "mode D session has no audio_track — upload endpoint should have written one"
            )
        return

    if session.mode != "A2":
        raise RuntimeError(
            f"acquire not yet implemented for mode {session.mode!r} — "
            "only Mode D upload and Mode A2 official artifacts are wired"
        )

    adapter = _get_platform_adapters().get(meeting.platform if meeting else None)
    if adapter is None:
        raise RuntimeError(
            f"no PlatformAdapter configured for platform {(meeting.platform if meeting else None)!r}"
        )
    platform_capture_id = meeting.platform_meeting_id if meeting else None
    if not platform_capture_id:
        raise RuntimeError("mode A2 session requires meeting.platform_meeting_id")

    db.query(AudioTrack).filter(AudioTrack.capture_session_id == session.id).delete()
    db.query(Participant).filter(Participant.capture_session_id == session.id).delete()
    artifacts = await adapter.acquire(platform_capture_id)
    if not artifacts.audio_tracks:
        raise RuntimeError("PlatformAdapter returned no audio tracks")
    _persist_capture_artifacts(db, session, artifacts)

    from app.capture.consent import record_disclosure

    record_disclosure(
        db,
        session,
        subject="all_participants",
        method="host_setting",
        detail=(
            f"platform={meeting.platform} recording/transcription auto-enabled by org "
            "settings; disclosed to participants via the platform's own in-meeting "
            "recording indicator — no bot in the room, per docs/03-capture.md"
        ),
    )


def _repair_context(db: object, session) -> tuple[list[str], list[str], list[str]]:
    """Roster + org glossary + screen-OCR context for the LLM repair pass.

    Glossary terms come from `GlossaryTerm` (app/api/corrections.py populates
    it — directly via the glossary UI, or implicitly from a transcript
    correction). A brand-new org with no corrections yet just gets an empty
    glossary; repair degrades gracefully to roster+OCR, it never breaks."""
    from sqlalchemy import select

    from app.db.models import GlossaryTerm, Keyframe, Participant

    roster = [
        p.display_name
        for p in db.execute(select(Participant).where(Participant.capture_session_id == session.id))
        .scalars()
        .all()
    ]
    glossary_terms = [
        g.term
        for g in db.execute(select(GlossaryTerm).where(GlossaryTerm.org_id == session.org_id))
        .scalars()
        .all()
    ]
    ocr_context = [
        kf.ocr_text
        for kf in db.execute(select(Keyframe).where(Keyframe.capture_session_id == session.id))
        .scalars()
        .all()
        if kf.ocr_text
    ]
    return roster, glossary_terms, ocr_context


@stage_handler("transcribe")
async def _handle_transcribe(db: object, job: PipelineJob) -> None:
    """Idempotent: clears any utterances (and this stage's coverage_interval
    rows) from a prior partial attempt before re-inserting, so a crash-and-
    retry never duplicates rows.

    Cascade output is passed through the LLM repair pass (app.asr.repair)
    before it becomes Utterance rows -- roster/OCR context the vendor APIs
    never had, used to fix errors at code-switch boundaries. A segment's
    `repaired` flag is set only when repair actually changed its text.

    Coverage gaps (CLAUDE.md rule 6) are detected from the cascade's RAW
    segments, before repair -- app.asr.coverage.detect_coverage_gaps reads
    the same empty-text/low-confidence signal the cascade already produces
    for an unrouted or failed span. Repair fixes text; it can't rescue a
    span nothing was transcribed from, so gap detection must not run on its
    output."""
    from sqlalchemy import select

    from app.asr.coverage import detect_coverage_gaps
    from app.asr.repair import repair_segments
    from app.config import get_settings
    from app.db.models import (
        AudioTrack,
        CaptureSession,
        CoverageInterval,
        CoverageStatus,
        Utterance,
    )
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
    db.query(CoverageInterval).filter(
        CoverageInterval.capture_session_id == session.id, CoverageInterval.modality == "audio"
    ).delete()

    roster, glossary_terms, ocr_context = _repair_context(db, session)
    transcriber = _get_transcriber()
    for track in tracks:
        result = await transcriber.transcribe(
            TranscriptionRequest(audio_uri=track.uri, org_id=session.org_id)
        )
        for gap in detect_coverage_gaps(result.segments):
            db.add(
                CoverageInterval(
                    org_id=session.org_id,
                    capture_session_id=session.id,
                    start_s=gap.start_s,
                    end_s=gap.end_s,
                    modality="audio",
                    status=CoverageStatus(gap.status.value),
                    reason=gap.reason,
                )
            )
        repaired_segments = await repair_segments(
            result.segments,
            roster=roster,
            glossary_terms=glossary_terms,
            ocr_context=ocr_context,
            llm=_get_llm(),
            model=get_settings().model_repair,
        )
        for original, seg in zip(result.segments, repaired_segments, strict=True):
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
                    repaired=seg.text != original.text,
                )
            )
    db.flush()
    log.info("transcribe.done", session=session.id, tracks=len(tracks))


_ocr_engine = None
_keyframe_detect_fn = None


def _get_ocr():
    global _ocr_engine
    if _ocr_engine is None:
        from app.adapters.blobstore_s3 import get_blobstore
        from app.adapters.ocr_paddle import PaddleOcrEngine

        _ocr_engine = PaddleOcrEngine(blob_store=get_blobstore())
    return _ocr_engine


def _get_keyframe_detect_fn():
    """Lazy singleton, same pattern as _get_transcriber -- overridable in
    tests via `app.orchestrator.worker._keyframe_detect_fn = <fake>` so the
    screen-stage test never needs opencv/imagehash/scikit-image installed."""
    global _keyframe_detect_fn
    if _keyframe_detect_fn is None:
        from app.screen.keyframe_detect import detect_keyframes

        _keyframe_detect_fn = detect_keyframes
    return _keyframe_detect_fn


@stage_handler("screen")
async def _handle_screen(db: object, job: PipelineJob) -> None:
    """Idempotent: clears any keyframes/groundings from a prior partial
    attempt before re-inserting. No video_uri is a normal outcome (audio-only
    Mode D, or a platform session with no screen share) -- honest absence of
    screen evidence, not a failure; the stage simply produces zero keyframes."""
    import tempfile
    from pathlib import Path

    from sqlalchemy import select

    from app.adapters.blobstore_s3 import get_blobstore
    from app.db.models import CaptureSession, Keyframe, Utterance, UtteranceKeyframe
    from app.screen.entities import extract_entities
    from app.screen.grounding import ground_utterances

    session = db.get(CaptureSession, job.capture_session_id)
    if session is None:
        raise RuntimeError(f"capture_session {job.capture_session_id} not found")

    existing_keyframe_ids = [
        kf.id
        for kf in db.execute(
            select(Keyframe.id).where(Keyframe.capture_session_id == session.id)
        ).all()
    ]
    if existing_keyframe_ids:
        db.query(UtteranceKeyframe).filter(
            UtteranceKeyframe.keyframe_id.in_(existing_keyframe_ids)
        ).delete(synchronize_session=False)
        db.query(Keyframe).filter(Keyframe.capture_session_id == session.id).delete()

    if not session.video_uri:
        log.info("stage.screen.no_video", session=session.id)
        return

    blob = get_blobstore()
    detect = _get_keyframe_detect_fn()
    ocr = _get_ocr()

    local_path = Path(session.video_uri)
    if local_path.exists():
        candidates = detect(str(local_path))
    else:
        data = await blob.get(session.video_uri)
        suffix = Path(session.video_uri).suffix or ".mp4"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(data)
            tmp_path = tmp.name
        try:
            candidates = detect(tmp_path)
        finally:
            Path(tmp_path).unlink(missing_ok=True)

    created: list[Keyframe] = []
    for cand in candidates:
        image_uri = await blob.put(
            f"keyframes/{session.org_id}/{session.id}/{cand.valid_from_s:.2f}.jpg",
            cand.image_bytes,
            content_type="image/jpeg",
        )
        ocr_result = await ocr.recognize(image_uri)
        entities = extract_entities(ocr_result.full_text)
        kf = Keyframe(
            org_id=session.org_id,
            capture_session_id=session.id,
            valid_from_s=cand.valid_from_s,
            valid_to_s=cand.valid_to_s,
            image_uri=image_uri,
            phash=cand.phash,
            ocr_text=ocr_result.full_text,
            # VLM captioning isn't wired to a real vision-capable LlmClient
            # yet (see app/adapters/vlm_caption.py's documented boundary) —
            # left blank rather than raising, same "optional enhancement,
            # never a hard requirement" rule the repair pass follows.
            vlm_caption="",
            detected_entities=[e.model_dump() for e in entities],
        )
        db.add(kf)
        created.append(kf)
    db.flush()

    if created:
        utterances = (
            db.execute(select(Utterance).where(Utterance.capture_session_id == session.id))
            .scalars()
            .all()
        )
        for grounding in ground_utterances(utterances, created):
            db.add(
                UtteranceKeyframe(
                    org_id=session.org_id,
                    utterance_id=grounding.utterance_id,
                    keyframe_id=grounding.keyframe_id,
                    score=grounding.score,
                    method=grounding.method,
                )
            )
    db.flush()
    log.info("screen.done", session=session.id, keyframes=len(created))


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

    await run_memory_intelligence(db, job.capture_session_id, _get_llm(), embedder=_get_embedder())


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


async def _serve_health_check(port: int) -> None:
    """The worker has no HTTP interface of its own -- it's a poll loop, not
    a request handler. That's fine for docker-compose (no port mapping,
    nothing depends on it), but deploying this process as a Cloud Run
    *Service* (google-github-actions/deploy-cloudrun targeting
    visualsprint-agents, see .github/workflows/deploy.yml) requires
    something listening on $PORT or Cloud Run kills the container as
    unhealthy. Reuses starlette/uvicorn -- already dependencies via
    fastapi[standard]/uvicorn[standard], so this adds nothing new."""
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import PlainTextResponse
    from starlette.routing import Route

    async def healthz(request):
        return PlainTextResponse("ok")

    app = Starlette(routes=[Route("/healthz", healthz), Route("/", healthz)])
    config = uvicorn.Config(app, host="0.0.0.0", port=port, log_level="warning")
    await uvicorn.Server(config).serve()


async def main() -> None:
    import os

    settings = get_settings()
    log.info("worker.start", worker=q.WORKER_ID)
    health_task = asyncio.create_task(_serve_health_check(int(os.environ.get("PORT", "8080"))))
    reap_counter = 0
    last_calendar_sync = datetime.min.replace(tzinfo=UTC)
    try:
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

            now = datetime.now(UTC)
            if (now - last_calendar_sync).total_seconds() >= settings.calendar_sync_interval_s:
                last_calendar_sync = now
                Session = get_sessionmaker()
                with Session() as db:
                    await _sync_all_calendars(db)
    finally:
        health_task.cancel()


if __name__ == "__main__":
    asyncio.run(main())
