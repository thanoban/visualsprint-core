# ASR Strategy — Buy Everything, Orchestrate the Gap

**No model training.** No GPU, no fine-tune, no ML research track. What vendors can't sell — Sinhala code-switching — is engineered around with routing + LLM repair.

## Vendor facts (primary-source verified, 2026)

- **Only two commercial vendors on Earth transcribe Sinhala:** Google `chirp_2` (`si-LK`) and Azure AI Speech (`si-LK`). Both also serve Tamil (`ta-IN`).
- ElevenLabs Scribe does **not** support Sinhala (its `/speech-to-text/sinhala` page 404s); Tamil sits in its 5–10% WER tier.
- Deepgram, AssemblyAI: no Sinhala at all — their generous free credits ($200 / $50) are English-only baselines for us.
- Neither Google nor Azure supports intra-sentence code-switching (Azure states it explicitly; Google is one-language-per-request).
- Whisper structurally cannot code-switch: language is detected once from the first 30 s and frozen ([transcribe.py](https://github.com/openai/whisper/blob/main/whisper/transcribe.py)).

## Locked: Google ⇄ Azure primary/fallback pair

- Weeks 1–3 rank the two on a gold set → loser becomes **automatic failover** (error, timeout, low confidence → transparent retry on the other). This also hedges vendor outage on our hardest language.
- Optional dual-call cross-check on low-confidence segments; disagreement arbitrated by LLM repair.
- Groq Whisper-v3-turbo covers English spans at $0.036/hr; Speechmatics `en_ta` bilingual pack is a candidate for Tamil–English spans.

## The cascade

```
audio → VAD (Silero) → VoxLingua107 language-ID per span (~0.75 s windows, merge adjacent)
                ↓
   ┌────────────┼────────────────┐
 English      Sinhala          Tamil
 Groq        Google ⇄ Azure   Google ⇄ Azure (+ en_ta candidate)
   └────────────┼────────────────┘
                ↓ stitch on original timestamps
   LLM repair pass — context vendors never see:
   roster (names) · org glossary (terms) · keyframe OCR (ticket IDs) · bilingual fluency
                ↓
        final transcript, per-utterance lang_tags + confidence
```

Diarization (speaker identity) is a **separate concern from this cascade** — it's the `Diarizer` interface, fused with platform speaker labels at keyframe/identity time (Phase 3), not a step inside ASR routing itself.

**Known cost:** the cascade is weakest at switch points (VAD+LID+ASR errors compound there). Eval reports **switch-point accuracy separately** — tracked, never hidden in average WER. LLM repair is the mitigation and quality lever.

## Implementation status

VAD, LID, and the Google/Azure/Groq routing cascade with auto-failover are implemented (`backend/app/asr/`, `backend/app/adapters/asr_*.py`) and satisfy the `Transcriber` protocol, so the orchestrator's `transcribe` stage (`backend/app/orchestrator/worker.py`) consumes them as a drop-in. **Not yet runtime-verified** — no live Google/Azure/Groq credentials configured, and `torch`/`speechbrain` (VAD/LID backends) aren't installed in dev yet. The gold set, eval harness, and LLM repair pass are not started.

## Gold set (weeks 1–3)

5–10 hrs real consented SL meeting audio, hand-transcribed. Permanent regression asset. Metrics: WER per language, switch-point accuracy, entity accuracy (ticket IDs, Sri Lankan names, tech terms), DER.

## Free-tier funding

Google $300 credit (~312 hrs chirp_2) + Azure F0/credit + Groq 240 hrs/mo ongoing → bake-off costs <$5; first pilot months nearly free.

## Costs

Sinhala is the expensive span (Google $0.96/hr) but routing sends only si-spans there; blended well under $0.30/hr. 10 pilot teams ≈ 600 hrs/mo ≈ low hundreds of $/mo, pure opex, scales to zero.

## Door kept open at zero cost

Corrections accrue (with consent) into the only si-ta-en CS corpus in existence. If the cascade proves insufficient, training can be revisited with evidence and data in hand. Reference for that future decision: IndicWhisper base (native Tamil + Indo-Aryan transfer to Sinhala), balanced fine-tuning per Polyglot-Lion, ~1000 hrs Tamil obtainable (Shrutilipi/Kathbath/SLR127) vs ~250 hrs Sinhala (OpenSLR SLR52).
