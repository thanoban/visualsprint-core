"""OcrEngine implementation — PaddleOCR (bought vendor, multilingual + layout).

PaddleOCR's published model zoo confirms English and a broad multilingual
set including Tamil (`ta`); **Sinhala (`si`) script support is not confirmed
in PaddleOCR's public model zoo as of this writing** — this is flagged
explicitly per docs/04-asr.md's "verify vendor claims, don't assume" rule,
not silently assumed to work. If si OCR proves inadequate in practice, the
`OcrEngine` Protocol (app/interfaces/ocr.py) is the only thing call sites
depend on, so swapping to another OCR vendor for si only touches this file.

Real inference lazy-loads paddleocr on first use only, so this module (and
unit tests that inject a fake backend) never requires network access or even
paddleocr to be installed.
"""

from __future__ import annotations

import tempfile
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Protocol

from app.interfaces.blobstore import BlobStore
from app.interfaces.ocr import OcrBlock, OcrResult

DEFAULT_LANG = "en"  # PaddleOCR lang code; "ta" available, "si" unconfirmed — see module docstring

RawOcrBlock = tuple[
    str, tuple[float, float, float, float], float
]  # text, normalized bbox, confidence


class OcrModelBackend(Protocol):
    def run(self, image_path: str) -> list[RawOcrBlock]: ...


class _PaddleOcrBackend:
    def __init__(self, lang: str = DEFAULT_LANG) -> None:
        self._lang = lang
        self._engine = None

    def _ensure_loaded(self) -> None:
        if self._engine is not None:
            return
        from paddleocr import PaddleOCR

        # show_log was removed in PaddleOCR 3.x; suppress via logging instead
        import logging as _logging
        _logging.getLogger("ppocr").setLevel(_logging.WARNING)
        self._engine = PaddleOCR(lang=self._lang, use_angle_cls=True)

    def run(self, image_path: str) -> list[RawOcrBlock]:
        self._ensure_loaded()
        import cv2

        image = cv2.imread(image_path)
        if image is None:
            return []
        height, width = image.shape[:2]

        raw_pages = self._engine.ocr(image_path, cls=True) or []
        blocks: list[RawOcrBlock] = []
        for page in raw_pages:
            for quad, (text, confidence) in page or []:
                xs = [point[0] for point in quad]
                ys = [point[1] for point in quad]
                bbox = (min(xs) / width, min(ys) / height, max(xs) / width, max(ys) / height)
                blocks.append((text, bbox, float(confidence)))
        return blocks


class PaddleOcrEngine:
    """`OcrEngine` Protocol implementation backed by PaddleOCR."""

    def __init__(
        self,
        backend: OcrModelBackend | None = None,
        blob_store: BlobStore | None = None,
        lang: str = DEFAULT_LANG,
    ) -> None:
        self._backend = backend or _PaddleOcrBackend(lang=lang)
        self._blob_store = blob_store

    async def recognize(self, image_uri: str) -> OcrResult:
        async with self._materialize_image(image_uri) as image_path:
            raw_blocks = self._backend.run(image_path)
        blocks = [
            OcrBlock(text=text, bbox=bbox, confidence=confidence)
            for text, bbox, confidence in raw_blocks
        ]
        return OcrResult(blocks=blocks)

    @asynccontextmanager
    async def _materialize_image(self, image_uri: str) -> AsyncIterator[str]:
        local_path = Path(image_uri)
        if local_path.exists():
            yield str(local_path)
            return

        from app.adapters.blobstore_local import LocalBlobStore

        blob_store = self._blob_store or LocalBlobStore()
        data = await blob_store.get(image_uri)
        suffix = Path(image_uri).suffix or ".jpg"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(data)
            tmp_path = tmp.name
        try:
            yield tmp_path
        finally:
            Path(tmp_path).unlink(missing_ok=True)
