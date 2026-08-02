# Gold set — ASR bake-off data

Empty on purpose: gold audio and transcripts are real consented recordings,
not something to fabricate. See `docs/04-asr.md` § "Running the bake-off"
for the full workflow.

Expected layout once populated:

```
gold/
  audio/             16kHz mono WAV clips
  samples.jsonl       hand-transcribed gold (app.evaluation.asr_eval.GoldSample)
  manifest.jsonl       id -> audio path (scripts/generate_asr_hypotheses.py)
  hypotheses/           generated per provider, not hand-written
  reports/               scored output from app.evaluation.asr_eval, for regression baselines
```

`audio/`, `hypotheses/`, and `reports/` are gitignored — recordings and
generated output don't belong in version control. `samples.jsonl` and
`manifest.jsonl` are small, hand-authored, and should be committed once real
data exists.
