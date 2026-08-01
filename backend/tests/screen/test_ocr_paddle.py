import cv2
import numpy as np
import pytest

from app.adapters.ocr_paddle import PaddleOcrEngine


class FakeOcrBackend:
    def __init__(self, blocks):
        self.blocks = blocks
        self.calls: list[str] = []

    def run(self, image_path: str):
        self.calls.append(image_path)
        return self.blocks


@pytest.fixture
def sample_image_path(tmp_path) -> str:
    path = tmp_path / "screen.png"
    frame = np.zeros((100, 200, 3), dtype=np.uint8)
    cv2.imwrite(str(path), frame)
    return str(path)


async def test_recognize_maps_backend_blocks_to_ocr_result(sample_image_path):
    backend = FakeOcrBackend(
        [
            ("PAY-442 status", (0.1, 0.1, 0.5, 0.2), 0.97),
            ("second line", (0.1, 0.3, 0.6, 0.4), 0.88),
        ]
    )
    engine = PaddleOcrEngine(backend=backend)

    result = await engine.recognize(sample_image_path)

    assert [b.text for b in result.blocks] == ["PAY-442 status", "second line"]
    assert result.full_text == "PAY-442 status\nsecond line"
    assert result.blocks[0].bbox == (0.1, 0.1, 0.5, 0.2)
    assert result.blocks[1].confidence == pytest.approx(0.88)
    assert backend.calls == [sample_image_path]


async def test_recognize_materializes_blob_uri_via_blob_store(sample_image_path):
    class FakeBlobStore:
        def __init__(self, data: bytes) -> None:
            self._data = data
            self.requested: list[str] = []

        async def get(self, uri: str) -> bytes:
            self.requested.append(uri)
            return self._data

    with open(sample_image_path, "rb") as f:
        raw_bytes = f.read()

    blob_store = FakeBlobStore(raw_bytes)
    backend = FakeOcrBackend([("text", (0.0, 0.0, 1.0, 1.0), 0.9)])
    engine = PaddleOcrEngine(backend=backend, blob_store=blob_store)

    result = await engine.recognize("blob://keyframes/some-id.png")

    assert blob_store.requested == ["blob://keyframes/some-id.png"]
    assert len(backend.calls) == 1
    assert backend.calls[0] != "blob://keyframes/some-id.png"  # materialized to a local temp path
    assert result.blocks[0].text == "text"


async def test_recognize_empty_image_returns_no_blocks(sample_image_path):
    class EmptyImageBackend:
        def run(self, image_path: str):
            return []

    engine = PaddleOcrEngine(backend=EmptyImageBackend())
    result = await engine.recognize(sample_image_path)
    assert result.blocks == []
