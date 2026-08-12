import math

import pytest

from app.adapters.speaker_embedder_pyannote import PyannoteSpeakerEmbedder
from app.interfaces.diarizer import SpeakerTurn


class FakeBackend:
    def embed(self, audio_uri: str, spans: list[tuple[float, float]]) -> list[list[float]]:
        assert audio_uri == "meeting.wav"
        assert spans == [(0.0, 4.0)]
        return [[3.0, 4.0]]


@pytest.mark.asyncio
async def test_embed_speakers_l2_normalizes_raw_pyannote_vectors():
    embedder = PyannoteSpeakerEmbedder(backend=FakeBackend())

    embeddings = await embedder.embed_speakers(
        "meeting.wav",
        [SpeakerTurn(start_s=0.0, end_s=4.0, cluster_id="speaker-1")],
    )

    assert embeddings["speaker-1"] == pytest.approx([0.6, 0.8])
    assert math.sqrt(sum(value * value for value in embeddings["speaker-1"])) == pytest.approx(1.0)


class ZeroBackend:
    def embed(self, audio_uri: str, spans: list[tuple[float, float]]) -> list[list[float]]:
        return [[0.0, 0.0]]


@pytest.mark.asyncio
async def test_embed_speakers_rejects_zero_vectors():
    embedder = PyannoteSpeakerEmbedder(backend=ZeroBackend())

    with pytest.raises(ValueError, match="zero or non-finite"):
        await embedder.embed_speakers(
            "meeting.wav",
            [SpeakerTurn(start_s=0.0, end_s=4.0, cluster_id="speaker-1")],
        )
