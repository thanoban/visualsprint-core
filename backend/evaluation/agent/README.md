# Agent evaluation corpus

`gold.seed.jsonl`, `predictions.seed.jsonl`, and `baseline.seed.json` are a
credential-free synthetic smoke corpus. They exercise every original session agent
and all four language cohorts (`en`, `si`, `ta`, `code_switch`) so metric and
regression-gate bugs fail CI.

They are **not an accuracy claim**. The baseline is intentionally a scorer fixture,
not output from Gemini and not a substitute for consented human-labelled meetings.
Production accuracy validation must replace or supplement it with a private corpus
whose rows use `"source_kind":"real_consented"`; run the evaluator with
`--require-real` so an all-synthetic corpus fails. Do not commit raw transcripts or
personally identifying audio to this repository.

The frozen report records prompt versions. Whenever a prompt or routed model changes,
produce a new prediction JSONL outside CI, score it against the unchanged private
gold set, review per-language and per-agent metrics, and update the accepted baseline
only after human review.
