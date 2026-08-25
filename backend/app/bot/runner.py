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
import contextlib
import io
import shutil
import signal
import subprocess
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import structlog

from app.db.base import get_sessionmaker
from app.db.models import BotSession, BotStatus
from app.interfaces.meeting_bot import JoinOutcome, MeetingJoiner

log = structlog.get_logger()

# Teams gates third-party bots behind an explicit organizer admit (docs/03-
# capture.md); 10 minutes is generous enough for a real meeting to notice
# and short enough that a bot doesn't sit idle in a dead lobby all day.
LOBBY_TIMEOUT_S = 600.0
MAX_MEETING_S = 4 * 3600.0  # safety cap so a stuck "live" poll can't run forever
_POLL_INTERVAL_S = 5.0
_LOBBY_POLL_INTERVAL_S = 10.0
# Keyframes are evidence, not a video archive. This bounded policy keeps a
# four-hour meeting within the Cloud Run writable-filesystem/memory budget.
SCREEN_MAX_KEYFRAMES = 90
SCREEN_MIN_KEEP_INTERVAL_S = 10.0
SCREEN_CHANGE_THRESHOLD = 10.0

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


def _webm_chunks_to_wav(chunks: list[bytes]) -> bytes | None:
    """Convert browser MediaRecorder WebM chunks to 16 kHz mono WAV.

    MediaRecorder emits independent WebM segments every _CHUNK_MS ms.
    Naive byte-concatenation produces an invalid container (only the first
    chunk has a valid Matroska file header), which soundfile/libsndfile
    cannot read. The concat demuxer must receive every independent segment
    as a separate file; piping joined bytes was the production bug that left
    successful bot captures stuck retrying the transcribe stage.

    Returns None when conversion cannot be completed. The caller treats that
    as a capture failure instead of publishing an untranscribable artifact.
    """
    if shutil.which("ffmpeg") is None:
        return None
    try:
        with tempfile.TemporaryDirectory(prefix="visualsprint-bot-audio-") as td:
            chunk_dir = Path(td)
            manifest = chunk_dir / "chunks.ffconcat"
            lines = ["ffconcat version 1.0"]
            for i, chunk in enumerate(chunks):
                if not chunk:
                    continue
                path = chunk_dir / f"chunk{i:06d}.webm"
                path.write_bytes(chunk)
                escaped_path = path.as_posix().replace("'", r"'\''")
                lines.append(f"file '{escaped_path}'")
            if len(lines) == 1:
                return None
            manifest.write_text("\n".join(lines) + "\n", encoding="utf-8")
            result = subprocess.run(
                [
                    "ffmpeg", "-y",
                    "-f", "concat",
                    "-safe", "0",
                    "-i", str(manifest),
                    "-ac", "1",
                    "-ar", "16000",
                    "-f", "wav",
                    "pipe:1",
                ],
                capture_output=True,
                timeout=300,
            )
        if result.returncode == 0 and result.stdout:
            return result.stdout
        log.warning(
            "bot.runner.webm_to_wav_failed",
            returncode=result.returncode,
            stderr=result.stderr.decode(errors="replace")[:400],
        )
    except Exception as exc:
        log.warning("bot.runner.webm_to_wav_failed", error=str(exc))
    return None



def _screen_signature(image_bytes: bytes) -> bytes:
    """Return a compact grayscale signature for perceptual comparison."""
    from PIL import Image

    with Image.open(io.BytesIO(image_bytes)) as image:
        return bytes(image.convert("L").resize((32, 18)).getdata())


def _should_keep_screen_frame(
    image_bytes: bytes,
    last_signature: bytes | None,
    last_kept_at_s: float | None,
    captured_at_s: float,
) -> tuple[bool, bytes | None]:
    """Keep meaningful visual changes, not every animated video tile."""
    if last_kept_at_s is not None and captured_at_s - last_kept_at_s < SCREEN_MIN_KEEP_INTERVAL_S:
        return False, last_signature
    try:
        signature = _screen_signature(image_bytes)
    except Exception as exc:
        # A malformed screenshot must not interrupt audio capture. Keep it so
        # the normal screen stage can make the final OCR decision.
        log.warning("bot.runner.screen_signature_failed", error=str(exc))
        return True, last_signature
    if last_signature is None:
        return True, signature
    mean_delta = sum(
        abs(a - b) for a, b in zip(signature, last_signature, strict=True)
    ) / len(signature)
    return mean_delta >= SCREEN_CHANGE_THRESHOLD, signature


def _host_admission_error(platform: str) -> str:
    if platform == "meet":
        return (
            "The organizer denied the Google Meet lobby request. A bot cannot bypass Meet "
            "host controls: invite the dedicated bot Google account to the event and allow "
            "that account (or everyone with the link) before capture starts."
        )
    if platform == "teams":
        return (
            "The organizer denied the Teams lobby request. A bot cannot bypass Teams host "
            "controls; add it as an allowed participant or change the lobby policy first."
        )
    return "The organizer denied the bot's lobby request."


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
        # joiner.error_detail carries the specific reason (session expired,
        # anonymous blocked, DOM change, etc.) set during the join flow.
        # Fall back to a generic message only if none was set.
        error_msg = getattr(joiner, "error_detail", None) or "join mechanics failed"
        _mark_status(bot_session_id, BotStatus.FAILED, error=error_msg)
        await _safe_leave(joiner)
        return
    if outcome == JoinOutcome.DENIED:
        _mark_status(bot_session_id, BotStatus.FAILED, error=_host_admission_error(platform))
        await _safe_leave(joiner)
        return

    if outcome == JoinOutcome.IN_LOBBY:
        _mark_status(bot_session_id, BotStatus.IN_LOBBY)
        outcome = await _wait_out_lobby(joiner)
        if outcome == JoinOutcome.DENIED:
            _mark_status(bot_session_id, BotStatus.FAILED, error=_host_admission_error(platform))
            await _safe_leave(joiner)
            return
        if outcome != JoinOutcome.LIVE:
            _mark_status(
                bot_session_id,
                BotStatus.LOBBY_TIMEOUT,
                lobby_timeout_at=datetime.now(UTC),
                error=(
                    "Lobby admission timed out. The organizer must allow the bot through "
                    "the meeting's host controls; the bot cannot bypass that policy."
                ),
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
    kept_screen_frames: list[tuple[Path, float]] = []

    async def _drain_audio() -> None:
        async for chunk in audio.chunks():
            audio_chunks.append(chunk.data)

    with tempfile.TemporaryDirectory(prefix="visualsprint-bot-screen-") as td:
        frame_dir = Path(td)

        async def _drain_screen() -> None:
            last_signature: bytes | None = None
            last_kept_at_s: float | None = None
            limit_logged = False
            async for frame in screen.frames():
                if len(kept_screen_frames) >= SCREEN_MAX_KEYFRAMES:
                    if not limit_logged:
                        log.warning(
                            "bot.runner.screen_frame_limit_reached",
                            bot_session=bot_session_id,
                            limit=SCREEN_MAX_KEYFRAMES,
                        )
                        limit_logged = True
                    continue
                keep, signature = _should_keep_screen_frame(
                    frame.image_bytes, last_signature, last_kept_at_s, frame.captured_at_s
                )
                if not keep:
                    continue
                last_signature = signature
                last_kept_at_s = frame.captured_at_s
                path = frame_dir / f"frame{len(kept_screen_frames):06d}.jpg"
                path.write_bytes(frame.image_bytes)
                kept_screen_frames.append((path, frame.captured_at_s))

        drain_tasks = [asyncio.create_task(_drain_audio()), asyncio.create_task(_drain_screen())]

        loop = asyncio.get_event_loop()
        started = loop.time()
        roster: list[Any] = []

        # SIGTERM from Cloud Run (manual cancel / scale-down) sets this event
        # so the capture loop exits cleanly and _finalize_capture still runs.
        _shutdown = asyncio.Event()
        install_sigterm_handler(bot_session_id, _shutdown)

        try:
            while loop.time() - started < MAX_MEETING_S:
                await asyncio.sleep(_POLL_INTERVAL_S)
                if _shutdown.is_set():
                    log.warning("bot.runner.shutdown_flag", bot_session=bot_session_id)
                    break
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
            for task in drain_tasks:
                try:
                    await asyncio.wait_for(task, timeout=10.0)
                except Exception:
                    task.cancel()
                    with contextlib.suppress(Exception):
                        await task
            await _safe_leave(joiner)

        _mark_status(bot_session_id, BotStatus.ENDED, ended_at=datetime.now(UTC))
        await _finalize_capture(
            bot_session_id, org_id, audio_chunks, kept_screen_frames, roster
        )


async def _finalize_capture(
    bot_session_id: str,
    org_id: str,
    audio_chunks: list[bytes],
    screen_frames: list[tuple[Path, float]],
    roster: list[Any],
) -> None:
    if not audio_chunks:
        log.warning("bot.runner.no_audio_captured", bot_session=bot_session_id)
        _mark_status(bot_session_id, BotStatus.FAILED, error="no audio captured during meeting")
        return

    from app.adapters.blobstore_s3 import get_blobstore
    from app.capture.consent import record_disclosure
    from app.capture.persist import persist_capture_artifacts
    from app.db.models import CaptureSession
    from app.interfaces.platform import (
        AudioTrack,
        CaptureArtifacts,
        CaptureMode,
        PreExtractedFrame,
        RosterEntry,
    )
    from app.orchestrator.queue import enqueue_pipeline

    blob_store = get_blobstore()

    # The pipeline consumes WAV/FLAC through soundfile. Never enqueue a joined
    # sequence of MediaRecorder fragments that only looks like a valid WebM.
    wav_audio = _webm_chunks_to_wav(audio_chunks)
    if not wav_audio:
        _mark_status(
            bot_session_id,
            BotStatus.FAILED,
            error="Captured audio could not be converted to WAV; no transcript was queued.",
        )
        return
    audio_blob_key = f"bot-audio/{org_id}/{bot_session_id}.wav"
    audio_content_type = "audio/wav"
    log.info("bot.runner.audio_converted_to_wav", bot_session=bot_session_id,
             size_bytes=len(wav_audio))

    Session = get_sessionmaker()
    with Session() as db:
        bot = db.get(BotSession, bot_session_id)
        if bot is None:
            return

        audio_uri = await blob_store.put(
            audio_blob_key,
            wav_audio,
            content_type=audio_content_type,
        )
        bot.audio_blob_uri = audio_uri

        # Upload each pre-filtered JPEG frame directly as a keyframe blob —
        # no mp4 mux needed. The bot already deduplicates near-identical
        # frames in _drain_screen, so these ARE the essential distinct
        # screenshots. The screen stage enriches them with OCR/captioning
        # in-place, skipping the video download + ffmpeg decode step entirely.
        preextracted: list[PreExtractedFrame] = []
        for i, (frame_path, captured_at_s) in enumerate(screen_frames):
            if not frame_path.exists():
                continue
            frame_bytes = frame_path.read_bytes()
            frame_uri = await blob_store.put(
                f"keyframes/{org_id}/{bot_session_id}/{i:06d}.jpg",
                frame_bytes,
                content_type="image/jpeg",
            )
            preextracted.append(PreExtractedFrame(image_uri=frame_uri, timestamp_s=captured_at_s))
        if preextracted:
            log.info("bot.runner.keyframes_uploaded", bot_session=bot_session_id,
                     count=len(preextracted))

        session = CaptureSession(org_id=org_id, meeting_id=bot.meeting_id, mode="B")
        db.add(session)
        db.flush()
        bot.capture_session_id = session.id

        artifacts = CaptureArtifacts(
            mode=CaptureMode.BOT,
            audio_tracks=[AudioTrack(uri=audio_uri, participant=None)],
            roster=[RosterEntry(display_name=r.display_name) for r in roster],
            preextracted_keyframes=preextracted,
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
            keyframes=len(preextracted),
            kept_screen_frames=len(screen_frames),
        )


def install_sigterm_handler(bot_session_id: str, shutdown_event: asyncio.Event) -> None:
    """Wire SIGTERM → graceful shutdown flag so Cloud Run cancel/scale-down
    triggers _finalize_capture instead of dying with data in memory."""
    loop = asyncio.get_event_loop()

    def _handle() -> None:
        log.warning(
            "bot.runner.sigterm",
            bot_session=bot_session_id,
            msg="SIGTERM received — setting shutdown flag to flush audio",
        )
        shutdown_event.set()

    with contextlib.suppress(NotImplementedError, RuntimeError):
        loop.add_signal_handler(signal.SIGTERM, _handle)
