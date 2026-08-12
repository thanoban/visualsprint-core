"""Pipeline definition — the deterministic FSM.

Stage order is fixed here, in code, by deterministic software. Agents never
choose the next stage. Each stage is an idempotent job: re-running it after a
crash produces the same rows (stages upsert keyed on capture_session_id).
"""

from app.db.models import CaptureState

# stage name -> (state while running, next stage)
STAGES: dict[str, tuple[CaptureState, str | None]] = {
    "acquire": (CaptureState.ACQUIRING, "diarize"),
    # diarize runs before transcribe so `transcribe` can attach speaker
    # identity as it creates Utterance rows, rather than needing a second
    # update pass over them (docs/08-speaker-identity.md).
    "diarize": (CaptureState.DIARIZING, "identify"),
    "identify": (CaptureState.IDENTIFYING, "transcribe"),
    "transcribe": (CaptureState.TRANSCRIBING, "screen"),
    "screen": (CaptureState.PROCESSING_SCREEN, "understand"),
    "understand": (CaptureState.UNDERSTANDING, "verify"),
    "verify": (CaptureState.VERIFYING, "remember"),
    "remember": (CaptureState.REMEMBERING, "propose"),
    "propose": (CaptureState.PROPOSING, "report"),
    "report": (CaptureState.REPORTING, None),
}

FIRST_STAGE = "acquire"


def next_stage(stage: str) -> str | None:
    return STAGES[stage][1]


def running_state(stage: str) -> CaptureState:
    return STAGES[stage][0]
