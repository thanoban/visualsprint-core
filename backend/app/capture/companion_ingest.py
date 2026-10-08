"""Retryable Mode C assembly on the acquire worker, using bounded file I/O."""

from __future__ import annotations

import asyncio
import json
import tempfile
from collections.abc import AsyncGenerator
from pathlib import Path
from typing import TYPE_CHECKING

from sqlalchemy import select

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

from app.adapters.blobstore_s3 import get_blobstore
from app.capture.audio_utils import transcode_webm_file
from app.capture.consent import record_disclosure
from app.capture.persist import persist_capture_artifacts
from app.db.models import AudioTrack, CaptureSession, CoverageInterval, CoverageStatus
from app.interfaces.platform import AudioTrack as Track
from app.interfaces.platform import CaptureArtifacts, CaptureMode, RosterEntry


async def assemble_companion_capture(db: Session, session: CaptureSession) -> None:
    """Keep source fragments until assembly succeeds; never compact missing time."""
    if db.execute(
        select(AudioTrack.id).where(AudioTrack.capture_session_id == session.id).limit(1)
    ).scalar_one_or_none():
        return
    org_id, session_id = session.org_id, session.id
    # No staged writes yet; release the pool slot during blob/ffmpeg work.
    db.expunge(session)
    db.rollback()
    store = get_blobstore()
    manifest = json.loads(await store.get(f"blob://companion-manifests/{org_id}/{session_id}.json"))
    total = manifest["total_chunks"]
    if not isinstance(total, int) or not 1 <= total <= 3600:
        raise RuntimeError("invalid companion manifest")
    with tempfile.TemporaryDirectory(prefix="visualsprint-companion-") as td:
        source = Path(td) / "recording.webm"
        output = Path(td) / "recording.flac"
        # MediaRecorder timeslices are fragments of one WebM container. Missing
        # fragments cannot safely be stitched or have their timestamps guessed.
        with source.open("wb") as stream:
            for seq in range(total):
                uri = f"blob://companion-chunks/{org_id}/{session_id}/{seq:06d}.webm"
                if not await store.exists(uri):
                    raise RuntimeError(f"companion audio chunk {seq} missing; retrying assembly")
                stream.write(await store.get(uri))
        await asyncio.to_thread(transcode_webm_file, source, output)

        async def file_chunks() -> AsyncGenerator[bytes, None]:
            with output.open("rb") as stream:
                while block := stream.read(1024 * 1024):
                    yield block

        audio_uri = await store.put_stream(
            f"companion-audio/{org_id}/{session_id}.flac", file_chunks(), content_type="audio/flac"
        )
    if not audio_uri.startswith("blob://"):
        raise RuntimeError("blob store returned an invalid audio URI")
    reloaded = db.get(CaptureSession, session_id)
    if reloaded is None:
        raise RuntimeError("companion capture disappeared during assembly")
    persist_capture_artifacts(
        db,
        reloaded,
        CaptureArtifacts(
            mode=CaptureMode.DESKTOP,
            audio_tracks=[Track(uri=audio_uri)],
            roster=[
                RosterEntry(display_name=name[:255])
                for name in dict.fromkeys(manifest["roster"])
                if name.strip()
            ],
        ),
    )
    if not manifest.get("microphone_captured", True):
        db.add(
            CoverageInterval(
                org_id=org_id,
                capture_session_id=session_id,
                start_s=0,
                end_s=manifest.get("duration_s", 0),
                modality="audio",
                status=CoverageStatus.MISSING,
                reason="companion_local_microphone_unavailable: owner's voice was not captured",
            )
        )
    record_disclosure(
        db,
        reloaded,
        subject="recording_owner",
        method="companion_extension",
        detail="Owner initiated browser-tab capture; chat notice is best-effort, not proof of participant consent.",
    )
