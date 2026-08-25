"""Worker loop — claims jobs, dispatches to stage handlers, records outcomes.

Stage handlers are registered in a plain dict; each receives (db, job) and
must be idempotent. Handlers for later phases are stubs that no-op until the
phase is built — the walking skeleton runs end-to-end from day one.
"""

import asyncio
import traceback
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from starlette.applications import Starlette

import structlog

from app.config import Settings, get_settings
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
_diarizer = None
_speaker_embedder = None
_platform_adapters = None
_calendar_adapters = None
_vlm_captioner = None
_EMBEDDER_UNAVAILABLE = object()
_SPEAKER_EMBEDDER_UNAVAILABLE = object()
_VLM_CAPTIONER_UNAVAILABLE = object()


def _get_llm():
    global _llm_client
    if _llm_client is None:
        provider = get_settings().llm_provider
        if provider == "foundry":
            from app.adapters.llm_foundry import FoundryLlmClient

            _llm_client = FoundryLlmClient()
        elif provider == "vertex":
            from app.adapters.llm_vertex import VertexLlmClient

            _llm_client = VertexLlmClient()
        else:
            from app.adapters.llm_gemini_vertex import GeminiVertexLlmClient

            _llm_client = GeminiVertexLlmClient()
    return _llm_client


def _get_transcriber():
    """Lazy singleton, same pattern as _get_llm — overridable in tests via
    `app.orchestrator.worker._transcriber = <fake>` so the walking-skeleton
    test never needs real Google/Azure/Groq credentials or torch/speechbrain."""
    global _transcriber
    if _transcriber is None:
        from app.adapters.blobstore_s3 import get_blobstore
        from app.asr.cascade import TranscriptionCascade, _TimeChunkVAD, _UnknownLID

        # Use time-chunked VAD and unknown-language LID stubs so that torch
        # and speechbrain are never imported in the agents worker.  This cuts
        # peak memory from ~1 GB to ~200 MB.  All audio goes to chirp_2 in
        # multilingual mode (si-LK + ta-IN + en-US simultaneously), which is
        # correct for code-switching audio and was the whole point of picking
        # chirp_2 (docs/04-asr.md).
        _transcriber = TranscriptionCascade(
            vad=_TimeChunkVAD(),  # type: ignore[arg-type]
            lid=_UnknownLID(),  # type: ignore[arg-type]
            blob_store=get_blobstore(),
        )
    return _transcriber


_embedder = None


def _build_embedder():
    from app.adapters.embedder_vertex import VertexEmbedder

    return VertexEmbedder()


def _get_embedder():
    """Lazy singleton, same pattern as _get_transcriber — overridable in
    tests via `app.orchestrator.worker._embedder = <fake>`. Memory
    Intelligence treats a missing embedder as an optional enhancement, not a
    hard requirement, so missing Vertex credentials degrade `remember` to
    keyword-overlap search, never break the stage."""
    global _embedder
    if _embedder is _EMBEDDER_UNAVAILABLE:
        return None
    if _embedder is None:
        try:
            _embedder = _build_embedder()
        except Exception as exc:
            _embedder = _EMBEDDER_UNAVAILABLE
            log.warning("embedder.unavailable", error=str(exc))
            return None
    return _embedder


def _build_speaker_embedder():
    from app.adapters.speaker_embedder_pyannote import PyannoteSpeakerEmbedder

    return PyannoteSpeakerEmbedder()


def _auto_add_person_glossary_terms(db: object, org_id: str, resolved: list) -> None:
    """After identify stage, upsert each resolved person's display_name as a
    GlossaryTerm so _repair_context feeds it into ASR repair for future sessions.
    Deduplicates by (org_id, term) — no-op when the term already exists.
    """
    from sqlalchemy import select

    from app.db.models import GlossaryTerm, Person

    person_ids = {r.person_id for r in resolved if r.person_id}
    if not person_ids:
        return
    people = (
        db.execute(select(Person).where(Person.id.in_(person_ids))).scalars().all()
    )
    existing_terms = {
        row.term
        for row in db.execute(
            select(GlossaryTerm.term).where(GlossaryTerm.org_id == org_id)
        ).all()
    }
    for person in people:
        if person.display_name and person.display_name not in existing_terms:
            db.add(GlossaryTerm(org_id=org_id, term=person.display_name))
            existing_terms.add(person.display_name)
    db.flush()


def _get_speaker_embedder():
    """Optional voice embedding backend for identity fusion.

    Missing Hugging Face credentials or pyannote deps leave speakers
    unresolved/roster-resolved; they must not break transcription.
    """
    global _speaker_embedder
    if _speaker_embedder is _SPEAKER_EMBEDDER_UNAVAILABLE:
        return None
    if _speaker_embedder is None:
        try:
            _speaker_embedder = _build_speaker_embedder()
        except Exception as exc:
            _speaker_embedder = _SPEAKER_EMBEDDER_UNAVAILABLE
            log.warning("speaker_embedder.unavailable", error=str(exc))
            return None
    return _speaker_embedder


# platform (Meeting.platform / CaptureArtifacts source) -> the OAuth
# provider name that grants access to it. "zoom" capture and "zoom" OAuth
# happen to share a name; meet/teams don't.
_PLATFORM_TO_OAUTH_PROVIDER = {"meet": "google", "zoom": "zoom", "teams": "microsoft"}


def _get_platform_adapter_for_session(db: object, org_id: str, platform: str | None):
    """Returns a PlatformAdapter for this org's Mode A2 capture on
    `platform`, or None if unavailable.

    If `_platform_adapters` (the module-level test-injection seam) is
    set, it's used directly by platform name -- the same override every
    existing Mode A2 test already relies on, unchanged.

    Otherwise builds a real per-org adapter via app/oauth/connection.py's
    shared lookup -- each org's own OAuth grant, not a single shared
    UnconfiguredTokenProvider instance for every org capturing on a given
    platform, which is what this used to do and would have been wrong
    the moment a second org connected the same platform (same bug class
    already fixed for calendar sync and the action-connector registry)."""
    if _platform_adapters is not None:
        return _platform_adapters.get(platform)

    provider = _PLATFORM_TO_OAUTH_PROVIDER.get(platform)
    if provider is None:
        return None

    from app.adapters.blobstore_s3 import get_blobstore
    from app.capture.meet_adapter import MeetAdapter
    from app.capture.teams_adapter import TeamsAdapter
    from app.capture.token_provider import UnconfiguredTokenProvider
    from app.capture.zoom_adapter import ZoomAdapter
    from app.oauth.connection import build_org_token_provider

    reasons = {
        "meet": "Google Meet OAuth not configured",
        "zoom": "Zoom OAuth not configured",
        "teams": "Microsoft Graph OAuth not configured",
    }
    token_provider = build_org_token_provider(db, org_id, provider) or UnconfiguredTokenProvider(
        reasons[platform]
    )
    blob_store = get_blobstore()
    if platform == "meet":
        return MeetAdapter(token_provider=token_provider, blob_store=blob_store)
    if platform == "zoom":
        return ZoomAdapter(token_provider=token_provider, blob_store=blob_store)
    if platform == "teams":
        return TeamsAdapter(token_provider=token_provider, blob_store=blob_store)
    return None


def _get_calendar_adapter_for_connection(db: object, connection):
    """Returns an adapter for this specific CalendarConnection.

    If `_calendar_adapters` (the module-level test-injection seam) is set,
    it's used directly by provider name -- the same override every
    existing calendar-sync test already relies on, unchanged.

    Otherwise builds a real per-connection adapter via
    app/oauth/connection.py's shared lookup: google and microsoft both
    have real OAuth grants behind them (app/api/oauth.py's callback wrote
    connection.secret_ref), so each connection's own token provider reads
    and refreshes that specific connection's tokens -- not a single
    shared instance for every org's connection to a given provider, which
    is what this used to do and would have been wrong the moment more
    than one org connected."""
    if _calendar_adapters is not None:
        return _calendar_adapters.get(connection.provider)

    from app.adapters.calendar_google import GoogleCalendarAdapter
    from app.adapters.calendar_microsoft import MicrosoftCalendarAdapter
    from app.oauth.connection import build_org_token_provider

    token_provider = build_org_token_provider(db, connection.org_id, connection.provider)
    if token_provider is None:
        return None
    if connection.provider == "google":
        return GoogleCalendarAdapter(token_provider=token_provider)
    if connection.provider == "microsoft":
        return MicrosoftCalendarAdapter(token_provider=token_provider)
    return None


def _is_missing_secret(exc: BaseException) -> bool:
    """True when an exception (or anything in its cause/context chain) is the
    secretstore's 'secret not found' KeyError (app/adapters/secretstore_*.py).
    That is a permanent condition -- the OAuth token was never stored or was
    lost -- and must be handled differently from a transient API/network
    error, which should keep retrying rather than prune the connection."""
    seen: BaseException | None = exc
    while seen is not None:
        if "secret not found" in str(seen):
            return True
        seen = seen.__cause__ or seen.__context__
    return False


async def _sync_all_calendars(db: object) -> None:
    """One pass over every CalendarConnection -- the periodic caller
    app/orchestrator/scheduler.py's sync_calendar_connection describes
    itself as needing. A failure on one connection (bad/expired token, API
    outage, missing OAuth app config) is logged and skipped, never stops
    the rest -- one org's broken calendar link must not silently starve
    every other org's meeting discovery."""
    from sqlalchemy import select

    from app.db.models import CalendarConnection
    from app.orchestrator.scheduler import sync_calendar_connection

    connections = db.execute(select(CalendarConnection)).scalars().all()
    for connection in connections:
        try:
            adapter = _get_calendar_adapter_for_connection(db, connection)
        except Exception as exc:
            log.warning(
                "calendar_sync.adapter_unavailable", connection=connection.id, error=str(exc)
            )
            continue
        if adapter is None:
            log.warning(
                "calendar_sync.unknown_provider",
                connection=connection.id,
                provider=connection.provider,
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
            if _is_missing_secret(exc):
                # The stored OAuth token is gone -- e.g. the connection was
                # made before VS_SECRETSTORE_BACKEND=gcp, so its token went to
                # the old ephemeral local secretstore and was lost on the next
                # deploy (the exact failure class in docs/14-production-
                # status.md). The row is now permanently unusable and would
                # otherwise re-raise this every single sync forever. Prune it
                # so it stops being retried and the UI shows "not connected",
                # prompting a fresh reconnect that writes a real secret --
                # self-heal, not a silent drop (logged as a distinct event).
                fresh = db.get(CalendarConnection, connection.id)
                if fresh is not None:
                    db.delete(fresh)
                    db.commit()
                log.warning(
                    "calendar_sync.connection_pruned",
                    connection=connection.id,
                    provider=connection.provider,
                    reason="oauth token missing from secret store — reconnect required",
                )
                continue
            log.warning("calendar_sync.failed", connection=connection.id, error=str(exc))


async def _run_retention_sweep(db: object) -> None:
    """One pass over every Org with Org.retention_days set (see
    app/orchestrator/retention.py for what's actually purged and why). A
    failure on one org (blob-store outage, bad row) is logged and skipped,
    same resilience pattern as _sync_all_calendars -- one org's problem must
    not block every other org's retention compliance."""
    from sqlalchemy import select

    from app.adapters.blobstore_s3 import get_blobstore
    from app.db.models import Org
    from app.orchestrator.audit import log_audit_event
    from app.orchestrator.retention import purge_expired_raw_evidence

    blob_store = get_blobstore()
    orgs = db.execute(select(Org).where(Org.retention_days.is_not(None))).scalars().all()
    for org in orgs:
        try:
            purged = await purge_expired_raw_evidence(db, org, blob_store)
            if purged:
                log_audit_event(
                    db,
                    org_id=org.id,
                    actor="system",
                    event="retention_purged",
                    detail={"capture_session_ids": purged, "retention_days": org.retention_days},
                )
            db.commit()
            if purged:
                log.info("retention.swept", org=org.id, sessions=len(purged))
        except Exception as exc:
            db.rollback()
            log.warning("retention.failed", org=org.id, error=str(exc))


async def _run_transcode_backfill(db: object) -> None:
    """One pass retrying non-FLAC AudioTrack blobs (see
    app/orchestrator/transcode_backfill.py). A failure must not block the
    worker's poll loop, same resilience convention as retention/calendar
    sweeps -- one bad blob shouldn't stop the rest from being retried."""
    from app.adapters.blobstore_s3 import get_blobstore
    from app.orchestrator.transcode_backfill import backfill_flac_transcodes

    blob_store = get_blobstore()
    try:
        transcoded = await backfill_flac_transcodes(db, blob_store)
        db.commit()
        if transcoded:
            log.info("transcode_backfill.swept", count=len(transcoded))
    except Exception as exc:
        db.rollback()
        log.warning("transcode_backfill.failed", error=str(exc))


async def _run_action_triggers(db: object) -> None:
    """One pass over every Org for the two time-driven action triggers
    (see app/orchestrator/action_triggers.py). Per-org isolated like every
    other sweep -- one org's bad data must not block another's."""
    from sqlalchemy import select

    from app.db.models import Org
    from app.orchestrator.action_triggers import (
        propose_commitment_reminders,
        propose_recurring_blocker_escalations,
    )

    settings = get_settings()
    orgs = db.execute(select(Org)).scalars().all()
    for org in orgs:
        try:
            escalated = propose_recurring_blocker_escalations(db, org.id)
            reminded = propose_commitment_reminders(
                db, org.id, within_hours=settings.action_trigger_reminder_window_hours
            )
            db.commit()
            if escalated or reminded:
                log.info(
                    "action_triggers.swept",
                    org=org.id,
                    escalated=len(escalated),
                    reminded=len(reminded),
                )
        except Exception as exc:
            db.rollback()
            log.warning("action_triggers.failed", org=org.id, error=str(exc))


async def _run_lifecycle_sweep(db: object) -> None:
    from sqlalchemy import select

    from app.agents.lifecycle import sweep_org_lifecycle
    from app.db.models import Org

    orgs = db.execute(select(Org)).scalars().all()
    for org in orgs:
        try:
            changed = sweep_org_lifecycle(db, org.id)
            db.commit()
            if changed:
                log.info("lifecycle.swept", org=org.id, changed=len(changed))
        except Exception as exc:
            db.rollback()
            log.warning("lifecycle.failed", org=org.id, error=str(exc))


async def _run_work_tracking_sweep(db: object) -> None:
    from sqlalchemy import select

    from app.db.models import Org
    from app.orchestrator.work_tracking import sweep_work_tracking

    orgs = db.execute(select(Org)).scalars().all()
    for org in orgs:
        try:
            created = await sweep_work_tracking(db, org.id)
            db.commit()
            if created:
                log.info("work_tracking.swept", org=org.id, evidence=len(created))
        except Exception as exc:
            db.rollback()
            log.warning("work_tracking.failed", org=org.id, error=str(exc))


_job_dispatcher = None


def _get_job_dispatcher():
    """Lazy singleton for the bot dispatch backend.

    "local"         → asyncio tasks inside this process (dev/test only).
    "cloud_run_job" → Cloud Run Jobs API execution per BotSession (prod).
    """
    global _job_dispatcher
    if _job_dispatcher is None:
        settings = get_settings()
        if settings.bot_dispatch_mode == "cloud_run_job":
            from app.adapters.job_dispatcher_cloud_run import CloudRunJobDispatcher

            project = settings.bot_cloud_run_project
            region = settings.bot_cloud_run_region
            if not project or not region:
                raise RuntimeError(
                    "VS_BOT_CLOUD_RUN_PROJECT and VS_BOT_CLOUD_RUN_REGION must be set "
                    "when VS_BOT_DISPATCH_MODE=cloud_run_job"
                )
            _job_dispatcher = CloudRunJobDispatcher(
                project=project,
                region=region,
                job_name=settings.bot_cloud_run_job_name,
            )
        else:
            from app.adapters.job_dispatcher_local import LocalJobDispatcher

            _job_dispatcher = LocalJobDispatcher()
    return _job_dispatcher


async def _run_bot_dispatch_sweep(db: object) -> None:
    """Dispatches due BotSession rows via the configured JobDispatcher.

    In "local" mode (dev): asyncio tasks in this process — the process must
    stay alive for the whole meeting, so only run locally, not on the
    scale-to-zero agents service.

    In "cloud_run_job" mode (prod): each BotSession becomes an independent
    Cloud Run Job execution (up to 24 h, billed per second of use). The
    agents service marks the session JOINING and creates the job; the job
    image (INSTALL_EXTRAS=bot) takes over from there, updating status to
    ACTIVE/DONE without needing the agents process to stay alive.

    Wrapped in its own try/except, same resilience convention as every other
    sweep — an unexpected error must not abort run_due_sweeps mid-pass."""
    if not get_settings().bot_dispatch_enabled:
        return

    from sqlalchemy import select

    from app.db.models import BotSession, BotStatus

    settings = get_settings()
    dispatcher = _get_job_dispatcher()
    slots = settings.bot_max_concurrent - dispatcher.in_flight_count()
    if slots <= 0:
        return

    try:
        now = datetime.now(UTC)
        cutoff = now + timedelta(seconds=settings.bot_dispatch_lookahead_s)
        # Don't dispatch sessions whose scheduled_start is more than the lobby
        # timeout in the past -- the meeting would have started without the bot
        # and a late-arriving join attempt would just sit in an empty lobby.
        # Sessions older than this are expired to MISSED instead.
        stale_cutoff = now - timedelta(seconds=settings.bot_dispatch_lookahead_s + 900)

        # Expire stale SCHEDULED sessions first (e.g. accumulated before
        # bot_dispatch_enabled was turned on, or while the service was down).
        stale = (
            db.execute(
                select(BotSession).where(
                    BotSession.status == BotStatus.SCHEDULED,
                    BotSession.scheduled_start < stale_cutoff,
                )
            )
            .scalars()
            .all()
        )
        for bot in stale:
            bot.status = BotStatus.MISSED
            log.info("bot_dispatch.expired", bot_session=bot.id, scheduled_start=bot.scheduled_start)

        due = (
            db.execute(
                select(BotSession)
                .where(
                    BotSession.status == BotStatus.SCHEDULED,
                    BotSession.scheduled_start <= cutoff,
                    BotSession.scheduled_start >= stale_cutoff,
                )
                .order_by(BotSession.scheduled_start)
                .limit(slots)
            )
            .scalars()
            .all()
        )
        for bot in due:
            bot.status = BotStatus.JOINING  # claim immediately — avoid double-dispatch next sweep
            db.flush()
            await dispatcher.dispatch(bot.id)
            log.info("bot_dispatch.launched", bot_session=bot.id, platform=bot.platform)
        if stale or due:
            db.commit()
    except Exception as exc:
        db.rollback()
        log.warning("bot_dispatch.failed", error=str(exc))


async def _run_longitudinal_sweep(db: object) -> None:
    from datetime import timedelta

    from sqlalchemy import select

    from app.db.models import Person
    from app.longitudinal.pipeline import run_person_analysis

    settings = get_settings()
    end = datetime.now(UTC)
    start = end - timedelta(days=settings.longitudinal_analysis_window_days)
    people = db.execute(select(Person)).scalars().all()
    for person in people:
        try:
            run = await run_person_analysis(
                db,
                person.org_id,
                person.id,
                start,
                end,
                _get_llm(),
                ensemble_size=settings.longitudinal_ensemble_size,
            )
            db.commit()
            log.info("longitudinal.swept", person=person.id, state=run.state.value)
        except Exception as exc:
            db.rollback()
            log.warning("longitudinal.sweep_failed", person=person.id, error=str(exc))


# _persist_capture_artifacts moved to app/capture/persist.py (as
# persist_capture_artifacts) so app/api/rtms_webhook.py can share it
# instead of duplicating it -- see that module's docstring for why it
# belongs in app/capture/, not here.


@stage_handler("acquire")
async def _handle_acquire(db: object, job: PipelineJob) -> None:
    """Mode D: audio already landed in blob storage at upload time (see
    api/upload.py) — this stage just confirms the audio_track row exists so a
    missing upload fails loudly here rather than silently at transcribe time.
    Other modes aren't wired to a PlatformAdapter yet; that is a later phase,
    and failing explicitly beats producing an empty session."""
    from sqlalchemy import select

    from app.db.models import AudioTrack, CaptureSession, Participant, PlatformSpeakerLabel

    session = db.get(CaptureSession, job.capture_session_id)
    if session is None:
        raise RuntimeError(f"capture_session {job.capture_session_id} not found")
    meeting = session.meeting

    has_track = db.execute(
        select(AudioTrack.id).where(AudioTrack.capture_session_id == session.id).limit(1)
    ).scalar_one_or_none()

    if session.mode in ("D", "B"):
        # Mode D: audio landed at upload time (api/upload.py). Mode B: audio
        # landed when app/bot/runner.py's _finalize_capture persisted it
        # after the bot left the meeting -- both are already-complete
        # CaptureArtifacts by the time this stage runs, so acquire's only
        # job is confirming that, same as Mode D.
        if has_track is None:
            raise RuntimeError(
                f"mode {session.mode} session has no audio_track — "
                "the capture step should have written one before enqueueing this stage"
            )
        return

    if session.mode != "A2":
        raise RuntimeError(
            f"acquire not yet implemented for mode {session.mode!r} — "
            "only Mode D upload and Mode A2 official artifacts are wired"
        )

    adapter = _get_platform_adapter_for_session(
        db, session.org_id, meeting.platform if meeting else None
    )
    if adapter is None:
        raise RuntimeError(
            f"no PlatformAdapter configured for platform {(meeting.platform if meeting else None)!r}"
        )
    platform_capture_id = meeting.platform_meeting_id if meeting else None
    if not platform_capture_id:
        raise RuntimeError("mode A2 session requires meeting.platform_meeting_id")

    db.query(AudioTrack).filter(AudioTrack.capture_session_id == session.id).delete()
    db.query(Participant).filter(Participant.capture_session_id == session.id).delete()
    db.query(PlatformSpeakerLabel).filter(
        PlatformSpeakerLabel.capture_session_id == session.id
    ).delete()
    artifacts = await adapter.acquire(platform_capture_id)
    if not artifacts.audio_tracks:
        raise RuntimeError("PlatformAdapter returned no audio tracks")

    from app.capture.persist import persist_capture_artifacts

    persist_capture_artifacts(db, session, artifacts)

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


def _build_diarizer():
    from app.adapters.diarizer_pyannote import PyannoteDiarizer

    return PyannoteDiarizer()


def _get_diarizer():
    """Lazy singleton, same pattern as _get_transcriber -- overridable in
    tests via `app.orchestrator.worker._diarizer = <fake>` so the diarize
    stage never needs pyannote.audio installed or a Hugging Face token."""
    global _diarizer
    if _diarizer is None:
        _diarizer = _build_diarizer()
    return _diarizer


def _assign_cluster(start_s: float, end_s: float, turns: list) -> tuple[str | None, float]:
    """Returns (cluster_id, overlap_ratio) for the diarized turn overlapping
    this utterance the most, or (None, 0.0) when nothing overlaps.

    The ratio is what keeps `attribution_confidence` honest: an utterance
    only 55% covered by a speaker turn must not claim the same certainty as
    a Zoom per-participant track, which is exact by construction."""
    duration = end_s - start_s
    if duration <= 0:
        return None, 0.0
    best_cluster: str | None = None
    best_overlap = 0.0
    for turn in turns:
        overlap = min(end_s, turn.end_s) - max(start_s, turn.start_s)
        if overlap > best_overlap:
            best_overlap = overlap
            best_cluster = turn.cluster_id
    if best_cluster is None:
        return None, 0.0
    return best_cluster, min(best_overlap / duration, 1.0)


@stage_handler("diarize")
async def _handle_diarize(db: object, job: PipelineJob) -> None:
    """Separates "who spoke when" from mixed audio, so every capture mode can
    attribute speech to a speaker rather than only Zoom per-participant
    tracks (docs/08-speaker-identity.md).

    Skipped entirely for per-participant tracks -- those already carry exact
    identity, and running diarization over them would replace a certainty
    with an estimate.

    Degrades rather than fails: pyannote's pipelines are Hugging-Face-gated
    (VS_HUGGINGFACE_TOKEN) and the model is large. If it is unavailable the
    session continues without speaker separation -- the same policy the
    optional VLM captioner uses -- because losing speaker labels is worth far
    less than losing the transcript entirely.

    Idempotent: clears this session's prior turns/speakers before inserting.
    """
    from sqlalchemy import select

    from app.db.models import AudioTrack, CaptureSession, SessionSpeaker, SpeakerTurn

    session = db.get(CaptureSession, job.capture_session_id)
    if session is None:
        raise RuntimeError(f"capture_session {job.capture_session_id} not found")

    tracks = (
        db.execute(select(AudioTrack).where(AudioTrack.capture_session_id == session.id))
        .scalars()
        .all()
    )
    mixed_tracks = [t for t in tracks if t.participant_person_id is None]
    if not mixed_tracks:
        log.info("diarize.skipped_per_participant", session=session.id)
        return

    db.query(SpeakerTurn).filter(SpeakerTurn.capture_session_id == session.id).delete()
    db.query(SessionSpeaker).filter(SessionSpeaker.capture_session_id == session.id).delete()

    try:
        diarizer = _get_diarizer()
    except Exception as exc:
        log.warning("diarize.unavailable", session=session.id, error=str(exc))
        return

    for track in mixed_tracks:
        try:
            result = await diarizer.diarize(track.uri)
        except Exception as exc:
            # Never fail the session over speaker labels -- see docstring.
            log.warning("diarize.failed", session=session.id, track=track.id, error=str(exc))
            continue
        for turn in result.turns:
            db.add(
                SpeakerTurn(
                    org_id=session.org_id,
                    capture_session_id=session.id,
                    audio_track_id=track.id,
                    start_s=turn.start_s,
                    end_s=turn.end_s,
                    cluster_id=turn.cluster_id,
                    confidence=turn.confidence,
                )
            )
        for cluster_id in sorted({turn.cluster_id for turn in result.turns}):
            # person_id stays null here: mapping a cluster to a real human is
            # identity fusion (Phase B), and guessing a name would be worse
            # than admitting the voice is unidentified.
            db.add(
                SessionSpeaker(
                    org_id=session.org_id,
                    capture_session_id=session.id,
                    audio_track_id=track.id,
                    cluster_id=cluster_id,
                )
            )
    db.flush()
    log.info("diarize.done", session=session.id, tracks=len(mixed_tracks))


@stage_handler("identify")
async def _handle_identify(db: object, job: PipelineJob) -> None:
    """Resolve diarized clusters to Person rows when deterministic evidence is strong.

    Roster labels and already-enrolled voiceprints are useful; uncalibrated
    guesses are not. Missing pyannote embedding support leaves embeddings
    blank and resolution falls back to roster-only or unresolved.
    """
    from sqlalchemy import select

    from app.db.models import (
        AudioTrack,
        CaptureSession,
        SessionSpeaker,
        SpeakerResolution,
        SpeakerTurn,
    )
    from app.speakers.identity import recompute_voiceprint, resolve_session_speakers

    session = db.get(CaptureSession, job.capture_session_id)
    if session is None:
        raise RuntimeError(f"capture_session {job.capture_session_id} not found")

    speakers = (
        db.execute(select(SessionSpeaker).where(SessionSpeaker.capture_session_id == session.id))
        .scalars()
        .all()
    )
    if not speakers:
        log.info("identify.no_speakers", session=session.id)
        return

    embedder = _get_speaker_embedder()
    if embedder is not None:
        tracks = (
            db.execute(select(AudioTrack).where(AudioTrack.capture_session_id == session.id))
            .scalars()
            .all()
        )
        speakers_by_track_cluster = {(s.audio_track_id, s.cluster_id): s for s in speakers}
        for track in tracks:
            turns = (
                db.execute(
                    select(SpeakerTurn).where(
                        SpeakerTurn.capture_session_id == session.id,
                        SpeakerTurn.audio_track_id == track.id,
                    )
                )
                .scalars()
                .all()
            )
            if not turns:
                continue
            try:
                embeddings = await embedder.embed_speakers(track.uri, turns)
            except Exception as exc:
                log.warning(
                    "identify.embedding_failed", session=session.id, track=track.id, error=str(exc)
                )
                continue
            for cluster_id, embedding in embeddings.items():
                speaker = speakers_by_track_cluster.get((track.id, cluster_id))
                if speaker is not None:
                    speaker.embedding = embedding
        db.flush()

    changed = resolve_session_speakers(db, session.id)
    for resolved in changed:
        if resolved.person_id and resolved.method in (
            SpeakerResolution.ROSTER,
            SpeakerResolution.MANUAL,
        ):
            recompute_voiceprint(db, resolved.person_id)
    # Auto-add each resolved person's display_name as a GlossaryTerm so
    # _repair_context improves ASR accuracy for their name in future sessions.
    _auto_add_person_glossary_terms(db, session.org_id, changed)
    log.info("identify.done", session=session.id, resolved=len(changed), speakers=len(speakers))


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
        SessionSpeaker,
        SpeakerTurn,
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
    # Diarization output from the previous stage, if any -- absent when the
    # session is per-participant (skipped) or pyannote was unavailable
    # (degraded), both of which must still produce a full transcript.
    speaker_turns = (
        db.execute(select(SpeakerTurn).where(SpeakerTurn.capture_session_id == session.id))
        .scalars()
        .all()
    )
    cluster_to_person = {
        (s.audio_track_id, s.cluster_id): s.person_id
        for s in db.execute(
            select(SessionSpeaker).where(SessionSpeaker.capture_session_id == session.id)
        )
        .scalars()
        .all()
    }
    # Detach all ORM objects from the session so they survive the commit
    # below as plain Python objects (attributes remain accessible), then
    # release the DB connection back to the pool before we make vendor
    # API calls that can take several minutes for a long meeting.
    org_id = session.org_id
    session_id = session.id
    db.expunge_all()
    db.commit()

    transcriber = _get_transcriber()
    for track in tracks:
        result = await transcriber.transcribe(
            TranscriptionRequest(audio_uri=track.uri, org_id=org_id)
        )
        for gap in detect_coverage_gaps(result.segments):
            db.add(
                CoverageInterval(
                    org_id=org_id,
                    capture_session_id=session_id,
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
            if track.participant_person_id:
                # Zoom per-participant track: identity is exact by
                # construction, so diarization is neither used nor needed.
                cluster_id: str | None = None
                person_id: str | None = track.participant_person_id
                attribution_confidence = 1.0
            else:
                track_turns = [turn for turn in speaker_turns if turn.audio_track_id == track.id]
                cluster_id, overlap_ratio = _assign_cluster(seg.start_s, seg.end_s, track_turns)
                person_id = cluster_to_person.get((track.id, cluster_id)) if cluster_id else None
                # Unknown person => 0.0, even on a clean cluster match: the
                # number claims confidence in *who*, not in the separation.
                attribution_confidence = overlap_ratio if person_id else 0.0
            db.add(
                Utterance(
                    org_id=org_id,
                    capture_session_id=session_id,
                    person_id=person_id,
                    start_s=seg.start_s,
                    end_s=seg.end_s,
                    text=seg.text,
                    lang_tags=[lang.value for lang in seg.lang_tags],
                    asr_confidence=seg.asr_confidence,
                    speaker_cluster_id=cluster_id,
                    attribution_confidence=attribution_confidence,
                    provider=seg.provider,
                    repaired=seg.text != original.text,
                )
            )
    db.flush()
    log.info("transcribe.done", session=session_id, tracks=len(tracks))


_ocr_engine = None
_keyframe_detect_fn = None


def _get_ocr():
    global _ocr_engine
    if _ocr_engine is None:
        from app.adapters.blobstore_s3 import get_blobstore
        from app.adapters.ocr_paddle import PaddleOcrEngine

        _ocr_engine = PaddleOcrEngine(blob_store=get_blobstore())
    return _ocr_engine


def _build_vlm_captioner():
    from app.adapters.vlm_caption import LlmVisionCaptioner

    return LlmVisionCaptioner(llm=_get_llm(), model=get_settings().model_classify)


def _get_vlm_captioner():
    """Optional screen-caption enhancement. If Vertex/vision setup is absent,
    keyframe OCR and grounding still run; only Keyframe.vlm_caption stays
    blank. Tests can inject `_vlm_captioner = <fake>` directly."""
    global _vlm_captioner
    if _vlm_captioner is _VLM_CAPTIONER_UNAVAILABLE:
        return None
    if _vlm_captioner is None:
        try:
            _vlm_captioner = _build_vlm_captioner()
        except Exception as exc:
            _vlm_captioner = _VLM_CAPTIONER_UNAVAILABLE
            log.warning("vlm_captioner.unavailable", error=str(exc))
            return None
    return _vlm_captioner


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

    # Snapshot the scalar fields we need before any deletes.
    session_id = session.id
    org_id = session.org_id
    video_uri = session.video_uri

    # Idempotency: clear prior stage output before re-running.
    # For video-based sessions, delete all keyframes so extraction starts fresh.
    # For pre-extracted bot frames (video_uri is None), DON'T delete — the
    # OCR enrichment pass below is idempotent (checks kf.ocr_text before re-doing).
    if video_uri:
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

    db.expunge_all()
    db.commit()

    blob = get_blobstore()
    detect = _get_keyframe_detect_fn()
    ocr = _get_ocr()
    captioner = _get_vlm_captioner()

    if not video_uri:
        # Check for bot-preextracted keyframes written by persist_capture_artifacts.
        # These are already uploaded distinct frames — only OCR/captioning needed.
        preextracted = (
            db.execute(select(Keyframe).where(Keyframe.capture_session_id == session_id))
            .scalars()
            .all()
        )
        if not preextracted:
            log.info("stage.screen.no_video", session=session_id)
            return

        # Enrich pre-extracted frames: OCR text, VLM caption, entity detection.
        for kf in preextracted:
            if kf.ocr_text:
                continue  # already enriched — idempotent re-run
            ocr_result = await ocr.recognize(kf.image_uri)
            entities = extract_entities(ocr_result.full_text)
            kf.ocr_text = ocr_result.full_text
            kf.detected_entities = [e.model_dump() for e in entities]
            if captioner is not None:
                try:
                    frame_bytes = await blob.get(kf.image_uri)
                    from app.adapters.vlm_caption import caption_keyframe

                    kf.vlm_caption = await caption_keyframe(frame_bytes, captioner=captioner)
                except Exception as exc:
                    log.warning("screen.caption_failed", session=session_id, error=str(exc))
        db.flush()

        utterances = (
            db.execute(select(Utterance).where(Utterance.capture_session_id == session_id))
            .scalars()
            .all()
        )
        for grounding in ground_utterances(utterances, preextracted):
            db.add(
                UtteranceKeyframe(
                    org_id=org_id,
                    utterance_id=grounding.utterance_id,
                    keyframe_id=grounding.keyframe_id,
                    score=grounding.score,
                    method=grounding.method,
                )
            )
        db.flush()
        log.info("screen.done", session=session_id, keyframes=len(preextracted))
        return

    local_path = Path(video_uri)
    if local_path.exists():
        candidates = detect(str(local_path))
    else:
        data = await blob.get(video_uri)
        suffix = Path(video_uri).suffix or ".mp4"
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
            f"keyframes/{org_id}/{session_id}/{cand.valid_from_s:.2f}.jpg",
            cand.image_bytes,
            content_type="image/jpeg",
        )
        ocr_result = await ocr.recognize(image_uri)
        entities = extract_entities(ocr_result.full_text)
        vlm_caption = ""
        if captioner is not None:
            try:
                from app.adapters.vlm_caption import caption_keyframe

                vlm_caption = await caption_keyframe(cand.image_bytes, captioner=captioner)
            except Exception as exc:
                log.warning("screen.caption_failed", session=session_id, error=str(exc))
        kf = Keyframe(
            org_id=org_id,
            capture_session_id=session_id,
            valid_from_s=cand.valid_from_s,
            valid_to_s=cand.valid_to_s,
            image_uri=image_uri,
            phash=cand.phash,
            ocr_text=ocr_result.full_text,
            vlm_caption=vlm_caption,
            detected_entities=[e.model_dump() for e in entities],
        )
        db.add(kf)
        created.append(kf)
    db.flush()

    if created:
        utterances = (
            db.execute(select(Utterance).where(Utterance.capture_session_id == session_id))
            .scalars()
            .all()
        )
        for grounding in ground_utterances(utterances, created):
            db.add(
                UtteranceKeyframe(
                    org_id=org_id,
                    utterance_id=grounding.utterance_id,
                    keyframe_id=grounding.keyframe_id,
                    score=grounding.score,
                    method=grounding.method,
                )
            )
    db.flush()
    log.info("screen.done", session=session_id, keyframes=len(created))


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
    """Claim and run one job. Returns True if a job was processed.

    Three transactions, deliberately, not one:

    1. Claim, then commit. `claim_next_job` increments `attempts`. If that
       increment is still uncommitted when the handler raises, the rollback
       below reverts it and `fail_job` -- reading from a fresh session -- sees
       `attempts == 0`. `attempts >= max_attempts` is then never true:
       `JobStatus.FAILED` and `CaptureState.FAILED` are unreachable, backoff
       is pinned at its first 5s step, and a deterministically-failing stage
       calls a paid vendor every 5 seconds forever. Committing the claim is
       what makes retry limits, exponential backoff, and reap_stuck_jobs work.
       A hard crash (OOM in torch/paddleocr) now leaves a durable RUNNING row
       for the reaper instead of vanishing.
    2. Run the handler against its own session.
    3. Fail in a fresh session, because the handler's session is poisoned.
    """
    Session = get_sessionmaker()

    # --- transaction 1: claim and commit ---
    with Session() as db:
        job = q.claim_next_job(db)
        if job is None:
            db.commit()
            return False
        job_id, stage, session_id = job.id, job.stage, job.capture_session_id
        db.commit()

    # --- transaction 2: run the handler ---
    with Session() as db:
        job = db.get(PipelineJob, job_id)
        if job is None:
            return True
        handler = _HANDLERS.get(stage, _noop)
        try:
            await handler(db, job)
            q.complete_job(db, job)
            db.commit()
            log.info("stage.done", stage=stage, session=session_id)
        except Exception as exc:
            db.rollback()
            # --- transaction 3: record failure in a clean session ---
            error = f"{exc}\n{traceback.format_exc(limit=5)}"
            with Session() as db2:
                job2 = db2.get(PipelineJob, job_id)
                if job2 is not None:
                    q.fail_job(db2, job2, error)
                    db2.commit()
            log.error("stage.failed", stage=stage, error=str(exc))
    return True


def _sweep_registry(settings: Settings) -> list[tuple[str, float, Callable[[object], Awaitable[None]]]]:
    """(name, interval_seconds, coroutine_fn) for every periodic sweep.

    Single source of truth for both the local-dev loop and the production
    bounded pass, so the two modes cannot silently drift apart -- a sweep
    added to one and not the other was a real risk with the old duplicated
    if-blocks this replaced."""
    sweeps: list[tuple[str, float, Callable[[object], Awaitable[None]]]] = [
        ("calendar_sync", settings.calendar_sync_interval_s, _sync_all_calendars),
        ("retention_sweep", settings.retention_sweep_interval_s, _run_retention_sweep),
        ("transcode_backfill", settings.transcode_backfill_interval_s, _run_transcode_backfill),
        ("action_triggers", settings.action_trigger_interval_s, _run_action_triggers),
        ("lifecycle_sweep", settings.lifecycle_sweep_interval_s, _run_lifecycle_sweep),
        ("work_tracking", settings.work_tracking_interval_s, _run_work_tracking_sweep),
        ("bot_dispatch", settings.bot_dispatch_interval_s, _run_bot_dispatch_sweep),
    ]
    if settings.longitudinal_analysis_enabled:
        sweeps.append(
            ("longitudinal_analysis", settings.longitudinal_analysis_interval_s, _run_longitudinal_sweep)
        )
    return sweeps


def _sweep_due(db: Any, name: str, interval_s: float, now: datetime) -> bool:
    """Durable due-check backed by WorkerSweepState (see its docstring) --
    not an in-memory timestamp, because the production worker no longer
    stays running between checks."""
    from app.db.models import WorkerSweepState

    state = db.get(WorkerSweepState, name)
    if state is None:
        return True
    last_run_at = state.last_run_at
    if last_run_at.tzinfo is None:
        last_run_at = last_run_at.replace(tzinfo=UTC)
    return bool((now - last_run_at).total_seconds() >= interval_s)


def _mark_swept(db: Any, name: str, now: datetime) -> None:
    from app.db.models import WorkerSweepState

    state = db.get(WorkerSweepState, name)
    if state is None:
        db.add(WorkerSweepState(name=name, last_run_at=now))
    else:
        state.last_run_at = now
    db.commit()


async def run_due_sweeps() -> list[str]:
    """Runs whichever periodic sweeps are due, using DB-persisted timestamps
    so this is correct whether called from an infinite loop or a fresh
    process spun up by Cloud Scheduler. Returns the names of sweeps that ran."""
    settings = get_settings()
    now = datetime.now(UTC)
    ran: list[str] = []
    for name, interval_s, fn in _sweep_registry(settings):
        Session = get_sessionmaker()
        with Session() as db:
            if not _sweep_due(db, name, interval_s, now):
                continue
        with Session() as db:
            await fn(db)
        with Session() as db:
            _mark_swept(db, name, now)
        ran.append(name)
    return ran


async def run_bounded_pass(max_seconds: float) -> dict[str, Any]:
    """Drain the job queue and run any due sweeps, then return -- this is
    the whole point of the scale-to-zero worker: Cloud Scheduler invokes it
    on a short interval, it does whatever work is pending, and the container
    is free to scale back to zero afterward instead of holding a paid vCPU
    open 24/7 waiting for the next job (see .github/workflows/deploy.yml and
    docs/EXTERNAL_SETUP.md's cost note). `max_seconds` is a safety bound, not
    a target -- an empty queue with no due sweeps returns almost instantly.
    """
    start = asyncio.get_event_loop().time()
    jobs_processed = 0
    while asyncio.get_event_loop().time() - start < max_seconds:
        processed = await run_once()
        if not processed:
            break
        jobs_processed += 1

    Session = get_sessionmaker()
    with Session() as db:
        reaped = q.reap_stuck_jobs(db)
        db.commit()

    swept = await run_due_sweeps()
    return {"jobs_processed": jobs_processed, "reaped": reaped, "swept": swept}


def _build_http_app() -> "Starlette":
    """Serves both the liveness probe Cloud Run requires of every Service
    (see the original docstring this replaced) and the trigger endpoint
    Cloud Scheduler calls to run one bounded pass. Reuses starlette/uvicorn
    -- already dependencies via fastapi[standard]/uvicorn[standard]."""
    from starlette.applications import Starlette
    from starlette.requests import Request
    from starlette.responses import JSONResponse, PlainTextResponse
    from starlette.routing import Route

    async def healthz(request: Request) -> PlainTextResponse:
        return PlainTextResponse("ok")

    async def run_endpoint(request: Request) -> JSONResponse:
        settings = get_settings()
        result = await run_bounded_pass(settings.worker_pass_max_seconds)
        return JSONResponse(result)

    return Starlette(
        routes=[
            Route("/healthz", healthz),
            Route("/", healthz),
            Route("/run", run_endpoint, methods=["POST"]),
        ]
    )


async def serve_http(port: int) -> None:
    """Production entrypoint: an HTTP server that does nothing until
    Cloud Scheduler calls POST /run, so Cloud Run can scale this service to
    zero between invocations instead of billing a permanently-open vCPU."""
    import uvicorn

    config = uvicorn.Config(_build_http_app(), host="0.0.0.0", port=port, log_level="warning")
    await uvicorn.Server(config).serve()


async def main() -> None:
    """Local-dev entrypoint (docker-compose): an always-on poll loop, same
    behaviour as before this module was split for production cost reasons.
    Production uses `serve_http` instead -- see VS_WORKER_MODE in
    app/config.py and .github/workflows/deploy.yml."""
    import os

    settings = get_settings()
    log.info("worker.start", worker=q.WORKER_ID, mode="loop")
    health_task = asyncio.create_task(serve_http(int(os.environ.get("PORT", "8080"))))
    try:
        while True:
            processed = await run_once()
            if not processed:
                await asyncio.sleep(settings.worker_poll_seconds)
            await run_due_sweeps()
    finally:
        health_task.cancel()


if __name__ == "__main__":
    import os

    # VS_WORKER_MODE=http is production's mode (Cloud Run scale-to-zero,
    # triggered by Cloud Scheduler POST /run -- see .github/workflows/
    # deploy.yml). Anything else (including unset, the local-dev default)
    # keeps the always-on poll loop docker-compose relies on.
    if os.environ.get("VS_WORKER_MODE", "loop") == "http":
        asyncio.run(serve_http(int(os.environ.get("PORT", "8080"))))
    else:
        asyncio.run(main())
