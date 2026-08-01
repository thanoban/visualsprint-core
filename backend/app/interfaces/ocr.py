"""OcrEngine swap point. Bought today: PaddleOCR (multilingual + layout)."""

from typing import Protocol

from pydantic import BaseModel, Field


class OcrBlock(BaseModel):
    text: str
    bbox: tuple[float, float, float, float]  # x0, y0, x1, y1 normalized 0..1
    confidence: float = Field(ge=0.0, le=1.0, default=1.0)


class OcrResult(BaseModel):
    blocks: list[OcrBlock]

    @property
    def full_text(self) -> str:
        return "\n".join(b.text for b in self.blocks)


class OcrEngine(Protocol):
    async def recognize(self, image_uri: str) -> OcrResult: ...
