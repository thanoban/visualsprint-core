#!/usr/bin/env python
"""Turn local audio into hypothesis JSONL for app.evaluation.asr_eval.

This is the missing link between the (complete) credential-free scorer and
actually running the si/ta/en bake-off (docs/04-asr.md § "Gold set"): the
scorer takes hypothesis JSONL as input but nothing previously produced it
from real audio using our own vendor adapters/cascade.

Two modes, matching the two questions the bake-off needs answered:

  --provider cascade
      Full pipeline: VAD -> LID -> Google/Azure/Groq routing with
      auto-failover -> (optionally) LLM repair. This is what production
      actually runs; use it to measure the system as a whole.

  --provider google|azure|groq --lang si|ta|en
      One vendor, whole-clip, forced language -- no VAD/LID/routing. This
      answers "does Google or Azure win on Sinhala" (docs/04-asr.md's week
      1-3 ranking question) in isolation, without cascade behaviour
      confounding the comparison. Matches the vendor adapters' actual
      contract: they are one-language-per-call and cannot code-switch, so
      forcing a single language is not a limitation of this script -- it is
      the vendor.

Input manifest is JSONL: {"id": "<gold sample id>", "audio": "<path to a
16kHz mono WAV, relative to the manifest file>"}. IDs must match the gold
set's ids (app.evaluation.asr_eval.GoldSample.id) for scoring to align
anything -- this script never reads the gold file, it only needs matching
ids, so gold authoring and hypothesis generation stay fully decoupled per
asr_eval's own design.

Usage:
    python scripts/generate_asr_hypotheses.py \\
        --manifest gold/manifest.jsonl --provider cascade \\
        --output gold/hypotheses/cascade.jsonl

    python scripts/generate_asr_hypotheses.py \\
        --manifest gold/manifest.jsonl --provider google --lang si \\
        --output gold/hypotheses/google-si.jsonl

Then rank: python -m app.evaluation.asr_eval --gold gold/samples.jsonl \\
    --hypothesis cascade=gold/hypotheses/cascade.jsonl \\
    --hypothesis google-si=gold/hypotheses/google-si.jsonl
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections.abc import Sequence
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.evaluation.asr_eval import normalize_tokens  # noqa: E402
from app.interfaces.transcriber import Lang, TranscriptSegment  # noqa: E402

VENDOR_LANGS: dict[str, set[str]] = {
    "google": {"si", "ta"},
    "azure": {"si", "ta"},
    "groq": {"en"},
}


class ManifestRow:
    __slots__ = ("id", "audio_path")

    def __init__(self, id: str, audio_path: Path) -> None:
        self.id = id
        self.audio_path = audio_path


def load_manifest(path: Path) -> list[ManifestRow]:
    base = path.parent
    rows: list[ManifestRow] = []
    seen: set[str] = set()
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path}:{line_number}: invalid JSON: {exc}") from exc
        if "id" not in obj or "audio" not in obj:
            raise ValueError(f"{path}:{line_number}: expected keys 'id' and 'audio'")
        if obj["id"] in seen:
            raise ValueError(f"{path}:{line_number}: duplicate id {obj['id']!r}")
        seen.add(obj["id"])
        audio_path = (base / obj["audio"]).resolve()
        if not audio_path.exists():
            raise FileNotFoundError(f"{path}:{line_number}: audio file not found: {audio_path}")
        rows.append(ManifestRow(id=obj["id"], audio_path=audio_path))
    if not rows:
        raise ValueError(f"{path}: manifest is empty")
    return rows


def segments_to_hypothesis_row(id: str, segments: Sequence[TranscriptSegment]) -> dict:
    """Assemble segment text into one hypothesis string and derive switch
    points as cumulative-token offsets at segment boundaries where the
    dominant language changes. This is coarser than a true per-word switch
    point (a segment can itself carry multiple lang_tags after repair), but
    it is a defensible, honest approximation: exact intra-segment switch
    detection would require word-level language tags the cascade does not
    currently emit, and pretending otherwise would misrepresent precision
    the harness doesn't actually have."""
    ordered = sorted(segments, key=lambda s: s.start_s)
    text_parts: list[str] = []
    switch_points: list[int] = []
    cumulative_tokens = 0
    previous_lang: Lang | None = None
    for segment in ordered:
        if not segment.text.strip():
            continue
        dominant = segment.lang_tags[0] if segment.lang_tags else Lang.UNKNOWN
        if previous_lang is not None and dominant != previous_lang:
            switch_points.append(cumulative_tokens)
        previous_lang = dominant
        text_parts.append(segment.text)
        cumulative_tokens += len(normalize_tokens(segment.text))
    return {"id": id, "text": " ".join(text_parts), "switch_points": switch_points}


async def _run_cascade(rows: list[ManifestRow]) -> list[dict]:
    from app.asr.cascade import TranscriptionCascade
    from app.interfaces.transcriber import TranscriptionRequest

    cascade = TranscriptionCascade()
    results = []
    for row in rows:
        result = await cascade.transcribe(TranscriptionRequest(audio_uri=str(row.audio_path), org_id="bakeoff"))
        results.append(segments_to_hypothesis_row(row.id, result.segments))
    return results


async def _run_single_vendor(rows: list[ManifestRow], provider: str, lang: str) -> list[dict]:
    if lang not in VENDOR_LANGS[provider]:
        raise ValueError(
            f"--provider {provider} does not serve --lang {lang} "
            f"(supported: {sorted(VENDOR_LANGS[provider])}) — see docs/04-asr.md vendor facts"
        )
    adapter = _build_adapter(provider)
    results = []
    for row in rows:
        audio_bytes = row.audio_path.read_bytes()
        raw = await adapter.transcribe_segment(audio_bytes, lang)
        segment = TranscriptSegment(
            start_s=0.0,
            end_s=0.0,
            text=raw.text,
            lang_tags=[Lang(lang)],
            asr_confidence=raw.confidence,
            provider=raw.provider,
        )
        results.append(segments_to_hypothesis_row(row.id, [segment]))
    return results


def _build_adapter(provider: str):
    if provider == "google":
        from app.adapters.asr_google import GoogleSpeechAdapter

        return GoogleSpeechAdapter()
    if provider == "azure":
        from app.adapters.asr_azure import AzureSpeechAdapter

        return AzureSpeechAdapter()
    if provider == "groq":
        from app.adapters.asr_groq import GroqSpeechAdapter

        return GroqSpeechAdapter()
    raise ValueError(f"unknown provider: {provider!r}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--manifest", required=True, type=Path, help="JSONL: {id, audio} per line")
    parser.add_argument(
        "--provider", required=True, choices=["cascade", "google", "azure", "groq"]
    )
    parser.add_argument(
        "--lang",
        choices=["si", "ta", "en"],
        help="Required for single-vendor providers (google/azure/groq); ignored for cascade",
    )
    parser.add_argument("--output", required=True, type=Path)
    return parser


async def _amain(args: argparse.Namespace) -> None:
    if args.provider != "cascade" and not args.lang:
        raise SystemExit(f"--lang is required for --provider {args.provider}")

    rows = load_manifest(args.manifest)
    if args.provider == "cascade":
        hypotheses = await _run_cascade(rows)
    else:
        hypotheses = await _run_single_vendor(rows, args.provider, args.lang)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as f:
        for row in hypotheses:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"wrote {len(hypotheses)} hypotheses to {args.output}", file=sys.stderr)


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    asyncio.run(_amain(args))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
