# ASR evaluation harness

This directory is the backend-only Phase 0b entrypoint. The permanent gold set
must contain consented, hand-transcribed meeting spans and must follow the JSONL
shape below. Do not commit private recordings or transcripts to this repository.

Gold row:

```json
{"id":"span-001","reference":"deploy eka Friday","language_tags":["si","en"],"switch_points":[2],"entities":["Friday"]}
```

Provider/cascade hypothesis row:

```json
{"id":"span-001","text":"deploy eka Friday","switch_points":[2]}
```

Run two providers and write a ranked report:

```powershell
cd backend
.\.venv\Scripts\python.exe -m app.evaluation.asr_eval `
  --gold .\evaluation\private\gold.jsonl `
  --hypothesis google=.\evaluation\private\google.jsonl `
  --hypothesis azure=.\evaluation\private\azure.jsonl `
  --output .\evaluation\private\report.json
```

The rank order is WER ascending, switch-point F1 descending, then entity
accuracy descending. Missing hypotheses count as empty transcripts and lower
coverage; extra hypothesis IDs are reported.

Freeze a reviewed report as a baseline outside the repository's private-data
boundary, then fail a later run on any regression:

```powershell
.\.venv\Scripts\python.exe -m app.evaluation.asr_eval `
  --gold .\evaluation\private\gold.jsonl `
  --hypothesis cascade=.\evaluation\private\cascade.jsonl `
  --baseline .\evaluation\private\baseline.json `
  --max-wer-increase 0.01 `
  --max-switch-f1-drop 0.02 `
  --max-entity-accuracy-drop 0.01
```

Metric definitions:

- WER is corpus-level Unicode-aware Levenshtein distance divided by reference words.
- Code-switch WER is reported only for samples tagged with multiple languages.
- A switch point matches within one normalized token boundary.
- Entity accuracy is exact normalized phrase retention over gold entities.
- Per-language WER includes every sample tagged with that language.
