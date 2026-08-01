# Capture Layer

**Key realization:** we don't want the platforms' transcripts — we want their **audio** and **speaker labels**. Their transcripts can't handle code-switching (our job); their capture infrastructure is free, official, and unbreakable by UI changes. The old browser screen-share approach is dead.

## Per-platform primary path (no bot)

| Platform | Primary method | Audio | Identity |
|---|---|---|---|
| Zoom | ⭐ RTMS WebSocket (live) or Cloud Recording per-participant files | **per-participant** | exact |
| Meet | ⭐ Meet REST API, pre-configured auto-recording + auto-transcript | mixed | transcript speaker labels ⊕ pyannote fusion |
| Teams | Graph API recordings + transcripts | mixed | transcript labels ⊕ fusion |

**Audio is the payload; their transcript is only a signal.** Every platform's transcript is single-language and mostly lacks si/ta (see language ceiling below) — we take their audio and run our own cascade. Enabling *transcription without recording* is supported everywhere and is the lighter-touch onboarding ask, but it yields no audio, so it is a degraded fallback rather than a primary path.

## Capture modes (org default + per-meeting override)

| Mode | How | Identity quality | Best for |
|---|---|---|---|
| **A1** | Zoom RTMS real-time | ⭐⭐⭐ exact per-participant | Zoom shops, best quality |
| **A2** | Official artifacts (Meet REST / Zoom Cloud Rec / Teams Graph) | ⭐⭐–⭐⭐⭐ | **Default for most orgs** |
| **B** | Bot joins as participant (Vexa/Attendee fork) | ⭐⭐ diarization ⊕ fusion | Orgs below required tier — deferred |
| **C** | Desktop companion app | ⭐ diarization only | Bot-hostile orgs, in-person |
| **D** | Manual upload | ⭐ diarization only | Onboarding, backfill, demos — **built first** |

Downstream consumes one normalized `capture_session`; weaker modes yield honestly lower confidence labels, never silent degradation.

**Disclosure always:** named participant, chat announcement, logged consent record. No stealth capture under any framing.

## Constraints found in research

- Meet REST requires Workspace Business Standard+ — detect tier at onboarding, route to best available mode.
- Teams Graph transcript access is **tenant-admin-gated from 29 Jul 2026** — detect the access error explicitly, fall back to B/C with the limitation stated.
- Zoom RTMS commercial terms (credits, approval, consent flow) unconfirmed — verify week 1; Cloud Recording API is the same-quality fallback.
- **Store all audio as FLAC forever** — every meeting stays re-transcribable as ASR improves; the corpus is the moat.

## Transcript-without-recording — available on all three platforms

Transcription is a **separate toggle from recording on every platform**, not a Zoom quirk. This matters for adoption: orgs that refuse recording (common — recording feels heavier legally and culturally) can enable transcription only, and we still get speaker-labelled timing.

| Platform | Mechanism | Independent of recording? |
|---|---|---|
| Meet | `artifactConfig.autoTranscriptionGeneration`, separate from `autoRecordingGeneration` | ✅ documented as independent |
| Teams | "Start transcription" separate from "Start recording"; Graph `callTranscript` | ✅ |
| Zoom | AI Companion transcript, `GET /meetings/{meetingId}/transcript` (webhook `postmeeting.aic_transcript_completed`; pass the **past-instance UUID**, not the scheduled meeting id) | ✅ works with cloud recording never enabled |

### Why this can never be our transcript — the language ceiling

Platform transcripts run on the platform's **own ASR**. There is no parameter to add languages, and this is exactly the gap the product exists to fill:

| Platform | Transcript languages | Sinhala | Tamil |
|---|---|---|---|
| Zoom AI Companion | 46 caption languages, but only **9** transcript/summary outputs (en, zh, ja, es, fr, de, pt, it, ar) | ❌ | ❌ |
| Teams | ~41 transcription languages (incl. Hindi) | ❌ | ❌ |
| Meet | ~103 caption languages | ✅ | ✅ |

**The "100+ languages" both vendors advertise is *translation of an existing transcript*, not recognition.** Translating an already-wrong Sinhala transcript cannot recover the speech — the error is baked in at recognition time, so translation is worthless to us.

**Consequence:** these transcripts stay a *cross-check and identity signal only* — speaker labels and timing, never text we trust. Our own Google ⇄ Azure cascade over the platform's **audio** remains the only path to si/ta code-switching. Where a platform offers transcript but no audio at all, that session degrades to a text-only fallback capped at low confidence and visibly labelled as such — never presented as a real transcript.

## Screen → keyframes

Sample 1–2 fps → dHash + SSIM delta → debounce (cursor noise, playing video, mid-transition) → keyframe with validity interval → PaddleOCR + Haiku caption + regex entities (ticket IDs, URLs, stack traces).

**Speech↔screen grounding:** utterance × keyframe by temporal overlap, boosted by lexical match (utterance says "PAY-442", OCR contains `PAY-442`). Answers *"what were they looking at when this was decided?"* — no competitor has this.

## Coverage honesty (first-class feature)

Health heartbeat → `coverage_interval` rows (`ok/degraded/missing` + reason). Knowledge overlapping a gap is flagged; reports state gaps plainly: *"11:42–11:44 audio not captured; knowledge from this interval may be incomplete."* Canary meeting on a schedule detects platform breakage. Nothing fails silently.
