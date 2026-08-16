"""Web Audio API injection (docs/03-capture.md Mode B) -- captures the
meeting tab's own output audio via MediaRecorder in short chunks. Runs
entirely inside an already-joined MeetingJoiner's page; this module only
needs a Playwright Page, not knowledge of which platform it's on.

Technique: route every <audio>/<video> element's output through a
MediaElementSource into one combined MediaStreamDestination, then record
that combined stream with MediaRecorder. A MutationObserver re-attaches new
elements as participants join mid-meeting -- the meeting UI adds/removes
media elements per-participant, so a one-time query at capture start would
miss anyone who joins after.
"""

from __future__ import annotations

import asyncio
import base64
import time
from collections.abc import AsyncIterator

import structlog

from app.interfaces.meeting_bot import AudioChunk

log = structlog.get_logger()

_CHUNK_MS = 5000

_CAPTURE_JS = f"""
() => {{
    if (window.__vsAudioRecorder) return;
    window.__vsAudioChunks = [];
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const combined = ctx.createMediaStreamDestination();

    const attach = (el) => {{
        if (el.__vsAttached) return;
        try {{
            const src = ctx.createMediaElementSource(el);
            src.connect(combined);
            el.__vsAttached = true;
        }} catch (e) {{ /* already attached or cross-origin -- skip, not fatal */ }}
    }};
    document.querySelectorAll('audio, video').forEach(attach);
    const observer = new MutationObserver((mutations) => {{
        for (const m of mutations) {{
            for (const node of m.addedNodes) {{
                if (!node.querySelectorAll) continue;
                if (node.tagName === 'AUDIO' || node.tagName === 'VIDEO') attach(node);
                node.querySelectorAll('audio, video').forEach(attach);
            }}
        }}
    }});
    observer.observe(document.body, {{ childList: true, subtree: true }});
    window.__vsAudioObserver = observer;

    const recorder = new MediaRecorder(combined.stream, {{ mimeType: 'audio/webm;codecs=opus' }});
    recorder.ondataavailable = async (e) => {{
        if (e.data.size === 0) return;
        const buf = await e.data.arrayBuffer();
        let binary = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        window.__vsOnChunk(btoa(binary));
    }};
    recorder.start({_CHUNK_MS});
    window.__vsAudioRecorder = recorder;
}}
"""

_STOP_JS = """
() => new Promise((resolve) => {
    if (!window.__vsAudioRecorder) return resolve();
    window.__vsAudioRecorder.onstop = () => resolve();
    window.__vsAudioRecorder.stop();
    if (window.__vsAudioObserver) window.__vsAudioObserver.disconnect();
})
"""


class PlaywrightAudioCapture:
    """BotAudioCapture backed by a joined page's Web Audio API MediaRecorder."""

    def __init__(self, page) -> None:
        self._page = page
        self._queue: asyncio.Queue[AudioChunk | None] = asyncio.Queue()
        self._seq = 0
        self._started_at = 0.0

    async def start(self) -> None:
        async def _on_chunk(b64: str) -> None:
            self._seq += 1
            await self._queue.put(
                AudioChunk(
                    seq=self._seq,
                    data=base64.b64decode(b64),
                    captured_at_s=time.monotonic() - self._started_at,
                )
            )

        await self._page.expose_function("__vsOnChunk", _on_chunk)
        self._started_at = time.monotonic()
        await self._page.evaluate(_CAPTURE_JS)
        log.info("bot.audio.started")

    async def chunks(self) -> AsyncIterator[AudioChunk]:
        while True:
            chunk = await self._queue.get()
            if chunk is None:
                return
            yield chunk

    async def stop(self) -> bytes:
        try:
            await self._page.evaluate(_STOP_JS)
        except Exception as exc:
            log.warning("bot.audio.stop_failed", error=str(exc))
        await self._queue.put(None)
        return b""
