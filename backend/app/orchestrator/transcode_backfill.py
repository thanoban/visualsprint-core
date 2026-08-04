"""Backfill sweep for audio blobs stored non-FLAC because ffmpeg wasn't on
PATH at ingest time -- app/capture/blob_ingest.py's `TODO(ffmpeg-unavailable)`
falls back to storing the raw bytes under their original extension rather
than stalling the pipeline. This sweep finds those AudioTrack rows, retries
the transcode now that ffmpeg may be provisioned, and replaces the blob and
row in place on success.

If ffmpeg is still unavailable, a track is left untouched (not a failure --
just "not yet possible") and picked up again on the next sweep. Idempotent:
already-FLAC tracks never match the query, so re-running is a safe no-op.
"""

import structlog
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.capture.blob_ingest import transcode_to_flac
from app.db.models import AudioTrack
from app.interfaces.blobstore import BlobStore

log = structlog.get_logger()

SCHEME = "blob://"


def _key_and_suffix(uri: str) -> tuple[str, str]:
    """Splits a blob:// URI into (key-without-extension, extension-with-dot).
    Mirrors blob_ingest.py's convention that `put()`'s key never includes an
    extension. Returns ("", "") if the URI has no recognizable extension --
    caller skips rather than guessing."""
    without_scheme = uri[len(SCHEME) :] if uri.startswith(SCHEME) else uri
    slash_idx = without_scheme.rfind("/")
    dot_idx = without_scheme.rfind(".")
    if dot_idx <= slash_idx:
        return "", ""
    return without_scheme[:dot_idx], without_scheme[dot_idx:]


async def backfill_flac_transcodes(db: Session, blob_store: BlobStore) -> list[str]:
    """One pass over every AudioTrack whose uri isn't already .flac. Does not
    commit -- caller owns the transaction, same convention as
    app/orchestrator/retention.py. Returns the AudioTrack ids re-transcoded
    this pass."""
    tracks = (
        db.execute(select(AudioTrack).where(~AudioTrack.uri.like("%.flac"))).scalars().all()
    )

    transcoded: list[str] = []
    for track in tracks:
        if not track.uri:
            continue  # already purged by retention.py -- nothing to transcode
        key, suffix = _key_and_suffix(track.uri)
        if not suffix:
            log.warning("transcode_backfill.unrecognized_uri", track=track.id, uri=track.uri)
            continue

        raw = await blob_store.get(track.uri)
        flac_bytes = transcode_to_flac(raw, suffix)
        if flac_bytes is None:
            continue  # ffmpeg still unavailable -- retry next sweep

        old_uri = track.uri
        new_uri = await blob_store.put(f"{key}.flac", flac_bytes, content_type="audio/flac")
        await blob_store.delete(old_uri)
        track.uri = new_uri
        transcoded.append(track.id)

    if transcoded:
        log.info("transcode_backfill.swept", count=len(transcoded))
    return transcoded
