"""VoxLingua107 language-ID over sliding windows — feeds the ASR cascade router.

Real inference lazy-loads speechbrain on first use only, so this module
(and unit tests that inject a fake backend) never requires network access
or even speechbrain to be installed.
"""

from typing import Protocol

from pydantic import BaseModel, Field

from app.asr.audio_io import slice_window
from app.interfaces.transcriber import Lang

WINDOW_S = 0.75
HOP_S = 0.75
MIN_CONFIDENCE = 0.5
MERGE_GAP_S = 0.05

_LANG_MAP: dict[str, Lang] = {"si": Lang.SI, "ta": Lang.TA, "en": Lang.EN}


class LabeledSpan(BaseModel):
    start_s: float
    end_s: float
    lang: Lang
    confidence: float = Field(ge=0.0, le=1.0, default=1.0)


class LidModelBackend(Protocol):
    def classify(self, samples, sample_rate: int) -> tuple[str, float]:
        """Returns (voxlingua107 language code e.g. 'si'/'ta'/'en', confidence)."""
        ...


class _VoxLingua107Backend:
    def __init__(self) -> None:
        self._classifier = None

    def _ensure_loaded(self) -> None:
        if self._classifier is not None:
            return
        from speechbrain.inference.classifiers import EncoderClassifier

        self._classifier = EncoderClassifier.from_hparams(
            source="speechbrain/lang-id-voxlingua107-ecapa",
            savedir="models/lang-id-voxlingua107-ecapa",
        )

    def classify(self, samples, sample_rate: int) -> tuple[str, float]:
        self._ensure_loaded()
        import torch

        tensor = torch.from_numpy(samples).unsqueeze(0)
        _, score, _, label = self._classifier.classify_batch(tensor)
        raw_label = str(label[0]).split(":")[0].strip()
        confidence = float(torch.exp(score[0]))
        return raw_label, confidence


class VoxLingua107LID:
    def __init__(self, backend: LidModelBackend | None = None) -> None:
        self._backend = backend or _VoxLingua107Backend()

    def label_language(
        self, audio_path: str, spans: list[tuple[float, float]]
    ) -> list[LabeledSpan]:
        frames: list[LabeledSpan] = []
        for span_start, span_end in spans:
            for w_start, w_end in _windows(span_start, span_end):
                samples, sample_rate = slice_window(audio_path, w_start, w_end)
                if len(samples) == 0:
                    continue
                raw_lang, confidence = self._backend.classify(samples, sample_rate)
                lang = _LANG_MAP.get(raw_lang, Lang.UNKNOWN)
                if confidence < MIN_CONFIDENCE:
                    lang = Lang.UNKNOWN
                frames.append(
                    LabeledSpan(start_s=w_start, end_s=w_end, lang=lang, confidence=confidence)
                )
        return _merge_adjacent(frames)


def label_language(
    audio_path: str, spans: list[tuple[float, float]], lid: VoxLingua107LID | None = None
) -> list[LabeledSpan]:
    lid = lid or VoxLingua107LID()
    return lid.label_language(audio_path, spans)


def _windows(span_start: float, span_end: float) -> list[tuple[float, float]]:
    windows: list[tuple[float, float]] = []
    cursor = span_start
    while cursor < span_end - 1e-9:
        w_end = min(cursor + WINDOW_S, span_end)
        windows.append((cursor, w_end))
        cursor += HOP_S
    return windows


def _merge_adjacent(frames: list[LabeledSpan]) -> list[LabeledSpan]:
    if not frames:
        return []
    merged = [frames[0]]
    for frame in frames[1:]:
        prev = merged[-1]
        same_lang = frame.lang == prev.lang
        contiguous = frame.start_s - prev.end_s <= MERGE_GAP_S
        if same_lang and contiguous:
            prev_duration = prev.end_s - prev.start_s
            frame_duration = frame.end_s - frame.start_s
            total_duration = prev_duration + frame_duration or 1.0
            merged_confidence = (
                prev.confidence * prev_duration + frame.confidence * frame_duration
            ) / total_duration
            merged[-1] = LabeledSpan(
                start_s=prev.start_s,
                end_s=frame.end_s,
                lang=prev.lang,
                confidence=merged_confidence,
            )
        else:
            merged.append(frame)
    return merged
