"""Orchestrates one Mode B bot-join capture end-to-end (docs/03-capture.md):
join -> wait out the lobby (or time out -- a first-class outcome, not a
hang) -> capture audio+screen while live -> on meeting end, flush captured
audio (and, if ffmpeg is available, muxed screen video) to blob storage,
persist a normal CaptureArtifacts payload, create a CaptureSession(mode="B"),
and enqueue the standard pipeline. Downstream stages (diarize, identify,
transcribe, screen, ...) never need to know the audio came from a bot rather
than a platform API -- this module's whole job is producing the same shape
Mode A2's acquire stage does.

Runs as a background asyncio task per BotSession, dispatched by the worker's
bot sweep (app/orchestrator/worker.py). Unlike the scale-to-zero pipeline
worker, the process running this must stay up for the whole meeting -- a
bot mid-capture can't be resumed from a cold start.
"""

from __future__ import annotations

import asyncio
import shutil
import subprocess
import tempfile
from datetime import UTC, datetime
from pathlib import Path

import structlog

from app.db.base import get_sessionmaker
from app.db.models import BotSession, BotStatus
from app.interfaces.meeting_bot import JoinOutcome, MeetingJoiner, ScreenFrame

log = structlog.get_logger()

# Teams gates third-party bots behind an explicit organizer admit (docs/03-
# capture.md); 10 minutes is generous enough for a real meeting to notice
# and short enough that a bot doesn't sit idle in a dead lobby all day.
LOBBY_TIMEOUT_S = 600.0
MAX_MEETING_S = 4 * 3600.0  # safety cap so a stuck "live" poll can't run forever
_POLL_INTERVAL_S = 5.0
_LOBBY_POLL_INTERVAL_S = 10.0

_joiner_factories: dict[str, type] | None = None  # test-injection seam


def _get_joiner_factories() -> dict[str, type]:
    global _joiner_factories
    if _joiner_factories is None:
        from app.adapters.bot_google_meet import GoogleMeetJoiner
        from app.adapters.bot_teams import TeamsJoiner
        from app.adapters.bot_zoom_web import ZoomWebJoiner

        _joiner_factories = {
            "meet": GoogleMeetJoiner,
            "teams": TeamsJoiner,
            "zoom": ZoomWebJoiner,
        }
    return _joiner_factories


def set_joiner_factories(factories: dict[str, type] | None) -> None:
    """Test seam -- inject fake joiners so tests never launch a real browser."""
    global _joiner_factories
    _joiner_factories = factories


def _build_joiner(platform: str) -> MeetingJoiner:
    cls = _get_joiner_factories().get(platform)
    if cls is None:
        raise RuntimeError(f"no MeetingJoiner for platform {platform!r}")
    return cls()


def _mark_status(bot_session_id: str, status: BotStatus, **fields) -> None:
    Session = get_sessionmaker()
    with Session() as db:
        bot = db.get(BotSession, bot_session_id)
        if bot is None:
            return
        bot.status = status
        for key, value in fields.items():
            setattr(bot, key, value)
        db.commit()


async def _safe_leave(joiner: MeetingJoiner) -> None:
    try:
        await joiner.leave()
    except Exception as exc:
        log.warning("bot.runner.leave_failed", error=str(exc))


async def _wait_out_lobby(joiner: MeetingJoiner) -> JoinOutcome:
    loop = asyncio.get_event_loop()
    started = loop.time()
    while loop.time() - started < LOBBY_TIMEOUT_S:
        await asyncio.sleep(_LOBBY_POLL_INTERVAL_S)
        outcome = await joiner.poll_status()
        if outcome != JoinOutcome.IN_LOBBY:
            return outcome
    return JoinOutcome.IN_LOBBY  # caller treats "still waiting" as a timeout


def _mux_frames_to_video(frames: list[ScreenFrame]) -> bytes | None:
    """Best-effort JPEG-sequence -> mp4 mux via ffmpeg, mirroring
    app/capture/blob_ingest.py's ffmpeg-optional convention: return None
    (never raise) when ffmpeg isn't on PATH, and let the screen stage's
    existing 'no video_uri' honest-absence path handle it -- a session
    without ffmpeg still gets a full transcript, just no keyframes."""
    if not frames or shutil.which("ffmpeg") is None:
        return None
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        for i, frame in enumerate(frames):
            (tdp / f"frame{i:06d}.jpg").write_bytes(frame.image_bytes)
        out = tdp / "out.mp4"
        try:
            subprocess.run(
                [
                    "ffmpeg", "-y",
                    "-framerate", "1",
                    "-i", str(tdp / "frame%06d.jpg"),
                    "-pix_fmt", "yuv420p",
                    str(out),
                ],
                check=True,
                capture_output=True,
            )
        except Exception as exc:
            log.warning("bot.runner.mux_failed", error=str(exc))
            return None
        return out.read_bytes()


async def run_bot_session(bot_session_id: str) -> None:
    """Entry point for one background bot task -- owns its own DB sessions
    for each state transition (mirrors app/orchestrator/worker.py's
    run_once) since this coroutine lives for the whole meeting, not one
    quick request/response cycle."""
    Session = get_sessionmaker()
    with Session() as db:
        bot = db.get(BotSession, bot_session_id)
        if bot is None:
            log.warning("bot.runner.session_missing", bot_session=bot_session_id)
            return
        platform, join_url, org_id = bot.platform, bot.join_url, bot.org_id
        bot.status = BotStatus.JOINING
        db.commit()

    try:
        joiner = _build_joiner(platform)
    except Exception as exc:
        _mark_status(bot_session_id, BotStatus.FAILED, error=str(exc))
        return

    try:
        outcome = await joiner.join(join_url)
    except Exception as exc:
        log.warning("bot.runner.join_failed", bot_session=bot_session_id, error=str(exc))
        _mark_status(bot_session_id, BotStatus.FAILED, error=f"join failed: {exc}")
        return

    if outcome == JoinOutcome.FAILED:
        _mark_status(bot_session_id, BotStatus.FAILED, error="join mechanics failed")
        await _safe_leave(joiner)
        return
    if outcome == JoinOutcome.DENIED:
        _mark_status(bot_session_id, BotStatus.FAILED, error="join request denied")
        await _safe_leave(joiner)
        return

    if outcome == JoinOutcome.IN_LOBBY:
        _mark_status(bot_session_id, BotStatus.IN_LOBBY)
        outcome = await _wait_out_lobby(joiner)
        if outcome == JoinOutcome.DENIED:
            _mark_status(bot_session_id, BotStatus.FAILED, error="never admitted from lobby")
            await _safe_leave(joiner)
            return
        if outcome != JoinOutcome.LIVE:
            _mark_status(
                bot_session_id,
                BotStatus.LOBBY_TIMEOUT,
                lobby_timeout_at=datetime.now(UTC),
                error="lobby admission timed out — organizer never admitted the bot",
            )
            await _safe_leave(joiner)
            return

    _mark_status(bot_session_id, BotStatus.LIVE, joined_at=datetime.now(UTC))

    from app.bot.audio_capture import PlaywrightAudioCapture
    from app.bot.screen_capture import PlaywrightScreenCapture

    audio = PlaywrightAudioCapture(joiner.page)
    screen = PlaywrightScreenCapture(joiner.page)
    await audio.start()
    await screen.start()

    audio_chunks: list[bytes] = []
    screen_frames: list[ScreenFrame] = []

    async def _drain_audio() -> None:
        async for chunk in audio.chunks():
            audio_chunks.append(chunk.data)

    async def _drain_screen() -> None:
        async for frame in screen.frames():
            screen_frames.append(frame)

    drain_tasks = [asyncio.create_task(_drain_audio()), asyncio.create_task(_drain_screen())]

    loop = asyncio.get_event_loop()
    started = loop.time()
    roster: list = []
    try:
        while loop.time() - started < MAX_MEETING_S:
            await asyncio.sleep(_POLL_INTERVAL_S)
            outcome = await joiner.poll_status()
            if outcome in (JoinOutcome.ENDED, JoinOutcome.FAILED, JoinOutcome.DENIED):
                break
    finally:
        try:
            roster = await joiner.roster()
        except Exception as exc:
            log.warning("bot.runner.roster_failed", error=str(exc))
        await screen.stop()
        await audio.stop()
        for t in drain_tasks:
            try:
                await asyncio.wait_for(t, timeout=10.0)
            except Exception:
                t.cancel()
        await _safe_leave(joiner)

    _mark_status(bot_session_id, BotStatus.ENDED, ended_at=datetime.now(UTC))
    await _finalize_capture(bot_session_id, org_id, audio_chunks, screen_frames, roster)


async def _finalize_capture(
    bot_session_id: str,
    org_id: str,
    audio_chunks: list[bytes],
    screen_frames: list[ScreenFrame],
    roster: list,
) -> None:
    if not audio_chunks:
        log.warning("bot.runner.no_audio_captured", bot_session=bot_session_id)
        _mark_status(bot_session_id, BotStatus.FAILED, error="no audio captured during meeting")
        return

    from app.adapters.blobstore_s3 import get_blobstore
    from app.capture.consent import record_disclosure
    from app.capture.persist import persist_capture_artifacts
    from app.db.models import CaptureSession
    from app.interfaces.platform import AudioTrack, CaptureArtifacts, CaptureMode, RosterEntry
    from app.orchestrator.queue import enqueue_pipeline

    blob_store = get_blobstore()
    raw_audio = b"".join(audio_chunks)

    # Muxed to mp4 when ffmpeg is available; otherwise video_uri stays unset
    # and the screen stage's existing "no video_uri" honest-absence path
    # handles it -- the transcript is unaffected either way.
    video_bytes = _mux_frames_to_video(screen_frames)

    Session = get_sessionmaker()
    with Session() as db:
        bot = db.get(BotSession, bot_session_id)
        if bot is None:
            return

        audio_uri = await blob_store.put(
            f"bot-audio/{org_id}/{bot_session_id}.webm",
            raw_audio,
            content_type="audio/webm",
        )
        bot.audio_blob_uri = audio_uri

        video_uri = None
        if video_bytes is not None:
            video_uri = await blob_store.put(
                f"bot-video/{org_id}/{bot_session_id}.mp4",
                video_bytes,
                content_type="video/mp4",
            )

        session = CaptureSession(org_id=org_id, meeting_id=bot.meeting_id, mode="B")
        db.add(session)
        db.flush()
        bot.capture_session_id = session.id

        artifacts = CaptureArtifacts(
            mode=CaptureMode.BOT,
            audio_tracks=[AudioTrack(uri=audio_uri, participant=None)],
            video_uri=video_uri,
            roster=[RosterEntry(display_name=r.display_name) for r in roster],
        )
        persist_capture_artifacts(db, session, artifacts)
        record_disclosure(
            db,
            session,
            subject="all_participants",
            method="bot_disclosure",
            detail=(
                f"platform={bot.platform} joined as a named guest "
                "('VisualSprint Notetaker') and announced recording in chat "
                "on entry — no recording permission required, per "
                "docs/03-capture.md Mode B."
            ),
        )
        enqueue_pipeline(db, org_id, session.id)
        db.commit()
        log.info(
            "bot.runner.finalized",
            bot_session=bot_session_id,
            capture_session=session.id,
            has_video=video_uri is not None,
        )
