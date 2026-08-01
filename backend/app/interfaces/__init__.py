"""Swap-point interfaces — the buy-now/own-later boundary.

Every external dependency is consumed ONLY through these Protocols.
Swapping a bought implementation (Google/Azure/Groq, pyannote, PaddleOCR,
Claude API, platform APIs) for an owned one must touch zero downstream code.
See docs/PROJECT_PLAN.md § "Built to scale, built to swap".
"""

from app.interfaces.actions import ActionConnector
from app.interfaces.blobstore import BlobStore
from app.interfaces.diarizer import Diarizer
from app.interfaces.llm import LlmClient
from app.interfaces.ocr import OcrEngine
from app.interfaces.platform import PlatformAdapter
from app.interfaces.transcriber import Transcriber

__all__ = [
    "ActionConnector",
    "BlobStore",
    "Diarizer",
    "LlmClient",
    "OcrEngine",
    "PlatformAdapter",
    "Transcriber",
]
