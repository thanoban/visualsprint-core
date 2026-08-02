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

**Implementation status:** Mode D upload is runtime-verified. Mode A2 Zoom Cloud
Recording and Meet REST adapters are implemented, unit-tested against fake HTTP,
and now wired into the worker's `acquire` stage through the `PlatformAdapter`
interface. The worker persists roster entries as participants, writes normalized
audio tracks, carries per-participant attribution where the platform provides it,
and records video/screen-share artifact URIs for the later screen stage. Live
OAuth/token providers and real-platform smoke tests are still not configured.

**Disclosure always:** named participant, chat announcement, logged consent record. No stealth capture under any framing.

## Constraints found in research

- Meet REST requires Workspace Business Standard+ — detect tier at onboarding, route to best available mode.
- Teams Graph transcript access is **tenant-admin-gated from 29 Jul 2026** — detect the access error explicitly, fall back to B/C with the limitation stated.
- **Platforms are actively tightening against third-party bots.** Microsoft announced 13 Mar 2026 that Teams detects external meeting bots, labels them "Unverified" in the lobby, and requires the organizer to explicitly admit them. This degrades Mode B on Teams (a human must click admit, every meeting) and is a further argument for the Graph API path over the bot fallback. Mode B must therefore handle "stuck in lobby, never admitted" as a first-class coverage-gap outcome, not a hang.
- Zoom RTMS commercial terms (credits, approval, consent flow) unconfirmed — verify week 1; Cloud Recording API is the same-quality fallback.
- **Store all audio as FLAC forever** — every meeting stays re-transcribable as ASR improves; the corpus is the moat.

## Nobody gets native access to someone else's platform — not even Zoom

Verified against vendor docs, and it settles the "can't we just do what AI Companion does?" question:

**Zoom AI Companion is native only inside Zoom.** On Meet and Teams it joins **as a guest bot** — Zoom's docs state it "will appear as a guest," joins Teams as an "*unverified guest*," and posts a chat message announcing it is transcribing.

| Platform | Zoom AI Companion | Gemini | Copilot | **Us** |
|---|---|---|---|---|
| Zoom | ✅ native | ❌ | ❌ | **RTMS** (native-equivalent) |
| Meet | 🤖 guest bot | ✅ native | ❌ | **Meet REST API** |
| Teams | 🤖 guest bot | ❌ | ✅ native | **Teams Graph API** |

**Consequence: first-party native access is unobtainable for any third party, so it is not a goal.** The reachable ceiling is (a) the platform's sanctioned media API, or (b) a disclosed guest bot — and Zoom itself falls back to (b) cross-platform.

**Our A2 path is less intrusive than Zoom's own cross-platform method.** Zoom uses bots on Meet/Teams likely because it *competes* with those platforms; depending on a rival's API is strategically awkward. We don't compete with them, so official APIs are open to us — no bot in the room, nothing in the lobby.

| Platform | Our access | What we take |
|---|---|---|
| Zoom | **RTMS** WebSocket — per-participant PCM + screen share, no bot | raw audio ⭐ |
| Meet | Meet REST artifacts — recording from Drive | raw audio + speaker labels |
| Teams | Graph `callRecording` | raw audio + speaker labels |

**We never use their transcript as our transcript**, because platform ASR has a hard language ceiling we cannot lift:

| Platform | Transcript languages | Sinhala | Tamil |
|---|---|---|---|
| Zoom AI Companion | 46 caption languages, but only **9** transcript/summary outputs | ❌ | ❌ |
| Teams | ~41 transcription languages (incl. Hindi) | ❌ | ❌ |
| Meet | ~103 caption languages | ✅ | ✅ |

There is no parameter to add languages — that ASR is theirs. The "100+ languages" both vendors advertise is *translation of an existing transcript*, not recognition: translating an already-wrong Sinhala transcript cannot recover the speech, since the error is baked in at recognition time.

**So: capture natively like AI Companion, then run our own Google ⇄ Azure cascade for si/ta code-switching.** Their transcripts are used only for speaker labels and timing (identity fusion), never for text we trust.

### Transcript-without-recording — a lighter onboarding ask

Transcription is a separate toggle from recording on **all three** platforms (Meet: `artifactConfig.autoTranscriptionGeneration` vs `autoRecordingGeneration`; Teams: "Start transcription" vs "Start recording"; Zoom: AI Companion transcript works with cloud recording off). Useful when an org refuses recording — but it yields **no audio**, so such a session degrades to a text-only fallback, capped at low confidence and visibly labelled, never presented as a real transcript.

## Screen → keyframes

Sample 1–2 fps → dHash + SSIM delta → debounce (cursor noise, playing video, mid-transition) → keyframe with validity interval → PaddleOCR + Haiku caption + regex entities (ticket IDs, URLs, stack traces).

**Speech↔screen grounding:** utterance × keyframe by temporal overlap, boosted by lexical match (utterance says "PAY-442", OCR contains `PAY-442`). Answers *"what were they looking at when this was decided?"* — no competitor has this.

## Coverage honesty (first-class feature)

Health heartbeat → `coverage_interval` rows (`ok/degraded/missing` + reason). Knowledge overlapping a gap is flagged; reports state gaps plainly: *"11:42–11:44 audio not captured; knowledge from this interval may be incomplete."* Canary meeting on a schedule detects platform breakage. Nothing fails silently.
