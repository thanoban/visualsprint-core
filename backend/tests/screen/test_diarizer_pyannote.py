import pytest

from app.adapters.diarizer_pyannote import PyannoteDiarizer


class FakeDiarizerBackend:
    def __init__(self, turns):
        self.turns = turns
        self.calls: list[tuple[str, int, int]] = []

    def run(self, audio_path: str, min_speakers: int, max_speakers: int):
        self.calls.append((audio_path, min_speakers, max_speakers))
        return self.turns


async def test_diarize_maps_backend_turns_to_result():
    backend = FakeDiarizerBackend(
        [
            (0.0, 2.5, "SPEAKER_00"),
            (2.5, 5.0, "SPEAKER_01"),
            (5.0, 6.0, "SPEAKER_00"),
        ]
    )
    diarizer = PyannoteDiarizer(backend=backend)

    result = await diarizer.diarize("blob://audio/meeting.flac", min_speakers=1, max_speakers=5)

    assert result.num_speakers == 2
    assert len(result.turns) == 3
    assert result.turns[0].cluster_id == "SPEAKER_00"
    assert result.turns[1].start_s == pytest.approx(2.5)
    assert backend.calls == [("blob://audio/meeting.flac", 1, 5)]


async def test_diarize_normalizes_non_standard_cluster_labels():
    backend = FakeDiarizerBackend([(0.0, 1.0, "A")])
    diarizer = PyannoteDiarizer(backend=backend)

    result = await diarizer.diarize("audio.flac")

    assert result.turns[0].cluster_id == "SPEAKER_A"


def test_missing_hf_token_raises_on_first_use():
    from app.adapters.diarizer_pyannote import _PyannoteBackend

    backend = _PyannoteBackend(hf_token=None)
    with pytest.raises(RuntimeError, match="huggingface_token"):
        backend.run("audio.flac", 1, 5)
