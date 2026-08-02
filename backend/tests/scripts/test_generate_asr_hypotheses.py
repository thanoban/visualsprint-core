"""generate_asr_hypotheses.py — the missing link that turns real audio into
hypothesis JSONL for app.evaluation.asr_eval. Fakes the cascade and vendor
adapters entirely (same pattern as tests/asr/test_cascade.py) so this needs
no torch/speechbrain/vendor credentials to prove the wiring is correct.
"""

import importlib.util
import json
import sys
from pathlib import Path

import pytest

from app.adapters.asr_common import RawVendorResult
from app.interfaces.transcriber import Lang, TranscriptionResult, TranscriptSegment

SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "generate_asr_hypotheses.py"


def _load_script():
    spec = importlib.util.spec_from_file_location("generate_asr_hypotheses", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


gen = _load_script()


@pytest.fixture
def audio_dir(tmp_path):
    d = tmp_path / "audio"
    d.mkdir()
    return d


def _write_wav(path: Path) -> None:
    import numpy as np
    import soundfile as sf

    sf.write(str(path), np.zeros(1600, dtype=np.float32), 16_000)


class TestLoadManifest:
    def test_resolves_relative_paths_and_parses_rows(self, tmp_path, audio_dir):
        _write_wav(audio_dir / "a.wav")
        manifest = tmp_path / "manifest.jsonl"
        manifest.write_text('{"id": "s1", "audio": "audio/a.wav"}\n', encoding="utf-8")

        rows = gen.load_manifest(manifest)

        assert len(rows) == 1
        assert rows[0].id == "s1"
        assert rows[0].audio_path == (audio_dir / "a.wav").resolve()

    def test_rejects_duplicate_ids(self, tmp_path, audio_dir):
        _write_wav(audio_dir / "a.wav")
        manifest = tmp_path / "manifest.jsonl"
        manifest.write_text(
            '{"id": "s1", "audio": "audio/a.wav"}\n{"id": "s1", "audio": "audio/a.wav"}\n',
            encoding="utf-8",
        )
        with pytest.raises(ValueError, match="duplicate id"):
            gen.load_manifest(manifest)

    def test_rejects_missing_audio_file(self, tmp_path):
        manifest = tmp_path / "manifest.jsonl"
        manifest.write_text('{"id": "s1", "audio": "nope.wav"}\n', encoding="utf-8")
        with pytest.raises(FileNotFoundError):
            gen.load_manifest(manifest)

    def test_rejects_empty_manifest(self, tmp_path):
        manifest = tmp_path / "manifest.jsonl"
        manifest.write_text("", encoding="utf-8")
        with pytest.raises(ValueError, match="empty"):
            gen.load_manifest(manifest)


class TestSegmentsToHypothesisRow:
    def test_assembles_text_and_derives_switch_points_at_language_boundaries(self):
        segments = [
            TranscriptSegment(
                start_s=0.0, end_s=1.0, text="API eka deploy", lang_tags=[Lang.EN], provider="p"
            ),
            TranscriptSegment(
                start_s=1.0, end_s=2.0, text="ready wenawa", lang_tags=[Lang.SI], provider="p"
            ),
            TranscriptSegment(
                start_s=2.0, end_s=3.0, text="issue fix", lang_tags=[Lang.EN], provider="p"
            ),
        ]
        row = gen.segments_to_hypothesis_row("s1", segments)

        assert row["id"] == "s1"
        assert row["text"] == "API eka deploy ready wenawa issue fix"
        # switch after 3 tokens (EN->SI), and after 5 tokens (SI->EN)
        assert row["switch_points"] == [3, 5]

    def test_sorts_out_of_order_segments_by_start_time(self):
        segments = [
            TranscriptSegment(start_s=2.0, end_s=3.0, text="second", lang_tags=[Lang.EN], provider="p"),
            TranscriptSegment(start_s=0.0, end_s=1.0, text="first", lang_tags=[Lang.EN], provider="p"),
        ]
        row = gen.segments_to_hypothesis_row("s1", segments)
        assert row["text"] == "first second"

    def test_skips_empty_segments_without_breaking_token_offsets(self):
        segments = [
            TranscriptSegment(start_s=0.0, end_s=1.0, text="hello", lang_tags=[Lang.EN], provider="p"),
            TranscriptSegment(start_s=1.0, end_s=1.5, text="", lang_tags=[Lang.UNKNOWN], provider="p"),
            TranscriptSegment(start_s=1.5, end_s=2.0, text="ayubowan", lang_tags=[Lang.SI], provider="p"),
        ]
        row = gen.segments_to_hypothesis_row("s1", segments)
        assert row["text"] == "hello ayubowan"
        assert row["switch_points"] == [1]


class FakeCascade:
    def __init__(self, by_uri: dict[str, TranscriptionResult]) -> None:
        self._by_uri = by_uri

    async def transcribe(self, request):
        return self._by_uri[request.audio_uri]


class FakeVendorAdapter:
    def __init__(self, result: RawVendorResult) -> None:
        self._result = result
        self.calls: list[tuple[bytes, str]] = []

    async def transcribe_segment(self, audio_bytes: bytes, lang_hint: str) -> RawVendorResult:
        self.calls.append((audio_bytes, lang_hint))
        return self._result


class TestEndToEndCli:
    def test_cascade_provider_writes_hypothesis_jsonl(self, tmp_path, audio_dir, monkeypatch):
        wav_path = audio_dir / "clip1.wav"
        _write_wav(wav_path)
        manifest = tmp_path / "manifest.jsonl"
        manifest.write_text('{"id": "clip1", "audio": "audio/clip1.wav"}\n', encoding="utf-8")

        fake_result = TranscriptionResult(
            segments=[
                TranscriptSegment(
                    start_s=0.0, end_s=1.0, text="mama enawa", lang_tags=[Lang.SI], provider="fake"
                )
            ],
            providers_used=["fake"],
        )
        fake_cascade = FakeCascade({str(wav_path.resolve()): fake_result})

        import app.asr.cascade as cascade_module

        monkeypatch.setattr(cascade_module, "TranscriptionCascade", lambda: fake_cascade)

        output = tmp_path / "out" / "cascade.jsonl"
        gen.main(["--manifest", str(manifest), "--provider", "cascade", "--output", str(output)])

        rows = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
        assert rows == [{"id": "clip1", "text": "mama enawa", "switch_points": []}]

    def test_single_vendor_provider_forces_language_and_writes_output(
        self, tmp_path, audio_dir, monkeypatch
    ):
        wav_path = audio_dir / "clip1.wav"
        _write_wav(wav_path)
        manifest = tmp_path / "manifest.jsonl"
        manifest.write_text('{"id": "clip1", "audio": "audio/clip1.wav"}\n', encoding="utf-8")

        fake_adapter = FakeVendorAdapter(
            RawVendorResult(text="deploy eka", confidence=0.9, provider="google:chirp_2:si-LK")
        )

        import app.adapters.asr_google as google_module

        monkeypatch.setattr(google_module, "GoogleSpeechAdapter", lambda: fake_adapter)

        output = tmp_path / "out" / "google-si.jsonl"
        gen.main(
            [
                "--manifest", str(manifest),
                "--provider", "google",
                "--lang", "si",
                "--output", str(output),
            ]
        )

        rows = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
        assert rows == [{"id": "clip1", "text": "deploy eka", "switch_points": []}]
        assert fake_adapter.calls[0][1] == "si"

    def test_unsupported_provider_language_combo_rejected(self, tmp_path, audio_dir):
        _write_wav(audio_dir / "clip1.wav")
        manifest = tmp_path / "manifest.jsonl"
        manifest.write_text('{"id": "clip1", "audio": "audio/clip1.wav"}\n', encoding="utf-8")

        with pytest.raises(ValueError, match="does not serve"):
            gen.main(
                [
                    "--manifest", str(manifest),
                    "--provider", "google",
                    "--lang", "en",
                    "--output", str(tmp_path / "out.jsonl"),
                ]
            )

    def test_missing_lang_for_single_vendor_provider_exits(self, tmp_path, audio_dir):
        _write_wav(audio_dir / "clip1.wav")
        manifest = tmp_path / "manifest.jsonl"
        manifest.write_text('{"id": "clip1", "audio": "audio/clip1.wav"}\n', encoding="utf-8")

        with pytest.raises(SystemExit):
            gen.main(
                [
                    "--manifest", str(manifest),
                    "--provider", "groq",
                    "--output", str(tmp_path / "out.jsonl"),
                ]
            )
