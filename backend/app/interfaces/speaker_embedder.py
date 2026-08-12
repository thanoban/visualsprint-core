"""SpeakerEmbedder swap point — turns a diarized voice into a vector.

Separate from `Diarizer` on purpose: diarization answers "how many voices and
when did each speak", embedding answers "what does this voice sound like, as
a number we can compare next week". Bought today: pyannote/embedding
(app/adapters/speaker_embedder_pyannote.py). A vendor that does both could
implement both Protocols without pipeline code changing.

Returns one centroid per cluster rather than one vector per turn — identity
is a property of a voice, not of an individual sentence, and averaging over a
speaker's turns is what makes the vector stable enough to match across
meetings.
"""

from typing import Protocol

from app.interfaces.diarizer import SpeakerTurn

# Dimensionality of the vectors this interface yields. Must match
# Person.voiceprint / SessionSpeaker.embedding's Vector(512) in db/models.py.
# Read empirically from pyannote/embedding's real output shape, not from
# documentation -- see docs/08-speaker-identity.md.
EMBEDDING_DIM = 512


class SpeakerEmbedder(Protocol):
    async def embed_speakers(
        self, audio_uri: str, turns: list[SpeakerTurn]
    ) -> dict[str, list[float]]:
        """Maps cluster_id -> centroid embedding for every cluster in `turns`.

        A cluster whose audio is too short or unreadable is omitted from the
        result rather than given a zero vector -- a meaningless vector that
        compares equal to other meaningless vectors would produce confident
        wrong identity matches, the one failure mode this feature cannot
        afford (docs/09-participant-intelligence.md).
        """
        ...
