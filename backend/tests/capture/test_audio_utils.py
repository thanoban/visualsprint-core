import io
import shutil
import subprocess
import wave

import pytest

from app.capture import audio_utils


@pytest.fixture
def ffmpeg(monkeypatch):
    executable = shutil.which("ffmpeg")
    if not executable:
        try:
            import imageio_ffmpeg
            executable = imageio_ffmpeg.get_ffmpeg_exe()
        except ImportError:
            pytest.skip("real audio regression requires ffmpeg or imageio-ffmpeg")
    monkeypatch.setattr(audio_utils.shutil, "which", lambda _: executable)
    return executable


def recording(ffmpeg):
    result = subprocess.run([ffmpeg, "-v", "error", "-f", "lavfi", "-i",
        "sine=frequency=440:sample_rate=48000:duration=2", "-c:a", "libopus",
        "-f", "webm", "pipe:1"], capture_output=True, check=True)
    return result.stdout


def test_continuous_timeslice_fragments_decode_whole_recording(ffmpeg):
    source = recording(ffmpeg)
    chunks = [source[i:i + 317] for i in range(0, len(source), 317)]
    result = audio_utils.webm_chunks_to_wav(chunks)
    assert result is not None
    with wave.open(io.BytesIO(result)) as output:
        assert output.getframerate() == 16000
        assert output.getnchannels() == 1
        # ffmpeg streaming WAV uses an unknown-length header; read actual PCM.
        assert len(output.readframes(16000 * 5)) / 32000 == pytest.approx(2, abs=0.05)


def test_independent_recordings_are_decoded_with_concat(ffmpeg):
    source = recording(ffmpeg)
    result = audio_utils.webm_chunks_to_wav([source, source])
    assert result is not None
    with wave.open(io.BytesIO(result)) as output:
        assert len(output.readframes(16000 * 6)) / 32000 == pytest.approx(4, abs=0.08)
