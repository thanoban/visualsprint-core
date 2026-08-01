# Verification & Risks

## Verification strategy

- **E2E replay:** feed a known code-switched recording through Mode D; assert utterances, keyframes, knowledge items, and report against ground truth. Later replay the same file through the A2 artifacts path.
- **Coverage integrity:** kill audio mid-recording → assert gap row, flagged items, explicit report disclosure.
- **Grounding:** utterance naming an on-screen ticket links to the correct keyframe.
- **Anti-hallucination:** schema test proves Report Intelligence's input contains no transcript text; every report claim resolves to a `knowledge_evidence` row.
- **ASR regression:** WER + switch-point + entity accuracy against the frozen gold set on every routing/vendor change.
- **Acceptance:** seed the three-meeting Postgres→blocker→MongoDB arc; ask *"why are we using MongoDB?"*; assert the answer traverses all three with speaker + transcript + screen evidence.
- **Automation gate:** proposed actions never execute without an approval record — asserted at the DB constraint level (`ck_action_requires_approval`).

## Risk register

| Risk | Mitigation |
|---|---|
| Only two Sinhala vendors exist; one fails or cuts quota | Locked primary/fallback pair with auto-failover; FLAC retention allows re-transcription |
| Cascade quality at switch points disappoints | Tracked explicitly from week 3; LLM repair is the lever; training door stays open with corpus accumulating |
| Org tier gates official capture (Meet Business Standard+, Teams admin toggle from 29 Jul 2026) | Detect at onboarding, route to best available mode, state the limitation |
| Zoom RTMS terms unworkable | Confirm week 1; Cloud Recording API is same-quality fallback |
| Fireflies/Otter add si/ta support | Their architecture (no cross-meeting context, no evidence grounding, no screen linking) is the moat, not the language list; corpus compounds meanwhile |
| LLM repair cost creep | Haiku for routine repair, Sonnet only for low-confidence segments; per-org budget caps |
| Scope is 12+ months | Phase 4 is a sellable slice at ~4 months; everything after is expansion |
