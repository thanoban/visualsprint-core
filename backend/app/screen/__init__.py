"""Screen-understanding pipeline — keyframe detection, OCR/VLM feed prep,
entity extraction, speech↔screen grounding. See docs/03-capture.md
(Screen → keyframes) and docs/05-data-model.md (Keyframe / UtteranceKeyframe).

Pure library code: no orchestrator wiring lives here.
"""
