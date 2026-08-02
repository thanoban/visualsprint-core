# VisualSprint — Full Project Plan

## Context

**The problem in one sentence:** a transcript alone cannot give the full context of a meeting — the real information lives in *speech + what was on screen at that moment + who said it + what earlier meetings established*. VisualSprint captures all four, fuses them with a multi-agent system, and turns meetings into **searchable, evidence-grounded organizational memory** for teams that mix **Sinhala, Tamil, and English** mid-sentence.

A prior prototype used browser screen-share capture and failed (wrong window, missing audio, manual start, nothing if the user was absent). That approach is abandoned; capture now uses the platforms' **official APIs first**, bots only as fallback.

**Outcome test:** six months post-deployment, "why are we using MongoDB?" returns a traced answer across three meetings — speaker, transcript span, and the screen content visible at each decisive moment — correctly transcribed through code-switching, with any capture gap honestly disclosed.

### Repository
[thanoban/visualsprint-core](https://github.com/thanoban/visualsprint-core) — empty scaffold, greenfield.

### Locked decisions
| Decision | Choice |
|---|---|
| Purpose | Commercial MVP for real users; professional, scalable architecture |
| Languages | Sinhala + Tamil + English from day one |
| ASR strategy | **Buy everything, train nothing.** Google `chirp_2` + Azure `si-LK`/`ta-IN` as the locked primary/fallback pair (the only two Sinhala vendors on Earth); Groq for English; orchestration + LLM repair covers code-switching. Own-model door kept open for later, at zero present cost |
| Capture | Official platform APIs first (Zoom RTMS / Cloud Recording, Meet REST, Teams Graph); bot/desktop/upload as fallback modes; all three platforms behind one adapter |
| Build-vs-buy principle | **Buy 3rd-party now, own later** — every bought component sits behind a stable internal interface so it can be swapped for an owned implementation without touching the rest of the system |

---

## Competitive position — parity fast, then beat them where they can't follow

Verified against 2026 reviews and vendor docs:

| Capability | Competitors' state | Our position |
|---|---|---|
| Capture, auto-join, transcription, summaries | Commodity — all do it well; platforms bundle it free | **Parity via official APIs**, not innovation target |
| Workflow automation | **Fireflies is the bar**: 200+ "AI Skills" automations, 70+ connectors, field-level CRM sync. Fathom drafts follow-up emails, posts to Slack | **Match the top ~10 automations** (below), each grounded in verified evidence — which they cannot do |
| Chat across meetings | Otter AI Chat asks across meetings **but is English-only and disclaims correctness**; Fireflies **"does not retain context across multiple meetings"** | ⭐ **Beat**: evidence-grounded chat over lifecycle-aware memory, trilingual |
| Speaker attribution | "Often inaccurate… muddied who said what" (Fireflies reviews) | ⭐ **Beat** on Zoom (exact per-participant audio); honest confidence labels elsewhere |
| Sinhala / si-ta-en code-switching | **Zero support anywhere**; Otter: 3 languages, English-only chat; Fireflies: one reply language | ⭐ **Own the category** |
| Speech↔screen grounding | Nobody links utterances to on-screen content temporally | ⭐ **Own the category** |
| Capture-coverage honesty | Nobody reports gaps; summaries silently paper over them | ⭐ **Own the category** |

**Strategy:** don't out-innovate on commodity; reach parity there quickly via official APIs + vendors, and pour effort into the four ⭐ rows — each is structural (they'd need our evidence model to copy it), not a feature toggle.

---

## Product surfaces

### 1. Meeting report
Generated **only** from verified knowledge items (never raw transcript — see agent rules). Sections: decisions, commitments (owner + due), blockers, questions, requirements; each with confidence badge, speaker, timestamp link, and screen evidence thumbnail. Coverage banner on top if any capture gap occurred.

### 2. Org-memory chat — "Claude Code for your meetings"
The user's framing is exact: like Claude Code holding full context of a codebase, the chat holds full context of the organization's meeting history. Ask anything:

- *"What did we decide about authentication?"* → decision + who + when + what was on screen
- *"What commitments does Udula still own?"* → open commitments with evidence links
- *"Has this blocker come up before?"* → lifecycle trail across meetings (RECURRING since May)
- *"Prep me for the 3pm standup"* → open items, unresolved questions, and last meeting's commitments for those attendees

Implementation: hybrid retrieval (pgvector + FTS) over `knowledge_item`, expansion along `knowledge_edge`, synthesis **constrained to retrieved items and their evidence** with citations rendered as clickable evidence chips. Where Otter disclaims "may not be factually correct," every claim we surface links to its source utterance/keyframe — that is the differentiation, enforced by architecture.

### 3. Automation layer (parity+, human-gated)
Competitors auto-execute; their weakness is acting on unverified extraction. We propose from **verified** knowledge and require one-click approval — same automation value, none of the "AI created a wrong Jira ticket" failure mode. MVP set, matching the top competitor automations:

| Automation | Trigger | Target |
|---|---|---|
| Follow-up email draft | Meeting report finalized | Gmail/Outlook draft (never auto-send) |
| Channel recap | Report finalized | Slack/Teams message (approve → post) |
| Task creation | Verified commitment with owner | Jira / GitHub Issues / Linear |
| Follow-up meeting | Unresolved blocker or explicit "let's meet again" | Calendar draft invite |
| Blocker escalation | Blocker marked RECURRING ≥ N meetings | Configurable notification |
| Commitment reminder | Due date approaching, still open | Owner DM draft |

Post-MVP: field-level CRM sync (HubSpot/Salesforce) to match Fireflies' connector depth, driven by the same verified-items pipeline. Batch approval UI ("approve all 4 proposed actions") keeps friction near zero, so the human gate costs seconds, not minutes.

### 4. Correction & glossary UI
Fix transcript spans and entity names; every fix updates the org glossary (immediately improving LLM repair for that org) and accrues — with explicit consent — into the only si-ta-en code-switched meeting corpus in existence. Product feature now, strategic asset forever.

---

## Architecture

### Non-negotiable spine
Deterministic software owns the workflow and decides what is true. Agents interpret content; they never call each other, never control orchestration, never self-certify.

```
Calendar watch ─→ Scheduler ─→ Capture (per meeting, mode A1/A2/B/C/D)
                                  ├─ audio  ─→ ASR cascade + diarization + identity ─→ utterances
                                  ├─ screen ─→ keyframe detect + OCR + VLM ─────────→ keyframes
                                  └─ health ─→ coverage intervals ──────────────────→ gap report
                                                      ↓
                        ┌──── deterministic FSM orchestrator (Postgres queue) ────┐
                        │   Context → Verification → Memory → Action → Report     │
                        │   (each stage: typed input → validated output)          │
                        └─────────────────────────────────────────────────────────┘
                                                      ↓
                                    knowledge_items + edges + evidence
                                                      ↓
                          Report  │  Org-memory chat  │  Automation proposals
```

**Five agents, one orchestrator** (roles per the brief): Context Intelligence extracts candidates (speech+screen+roster); Evidence Verification challenges them blind — it sees the claim and raw evidence, never the extractor's reasoning — and assigns `verified / partially_supported / ambiguous / unsupported`; Memory Intelligence links against history and assigns lifecycle; Action Intelligence proposes automations; Report Intelligence renders the report.

**Two rules enforced by types, not prompts:**
1. Report Intelligence's input schema **cannot contain raw transcript** — hallucination cannot reach the user-facing report.
2. Verification never sees Context's justification — self-consistency is not verification.

### Technology
| Layer | Choice | Why |
|---|---|---|
| Backend | Python 3.12, FastAPI | one language across pipeline + API |
| Orchestration | Postgres-backed FSM, `FOR UPDATE SKIP LOCKED` workers | durable, inspectable, zero extra infra; **documented upgrade path → Temporal** when scale demands |
| Data | PostgreSQL 16 + pgvector + FTS | relational + vector + graph edges in one store; no Neo4j, no separate vector DB at this scale |
| Blobs | S3-compatible (Cloudflare R2) | zero egress fees on audio/keyframe volume |
| Agents | Claude API — Sonnet (extract/verify), Haiku (classify/caption), Opus (cross-meeting memory) | tiered by task difficulty |
| Frontend | Next.js + TypeScript | report, chat, corrections, approvals |
| Deploy | Docker Compose (pilot) → K8s (scale) | same images both stages |

### Built to scale, built to swap
Professional-architecture requirements, addressed concretely:

- **Stateless services** — API, workers, and capture runners share no local state (all state in Postgres/R2), so every tier scales horizontally by adding replicas.
- **Queue-decoupled stages** — each FSM stage is an idempotent job; retries are safe, backpressure is natural, a stuck meeting never blocks others.
- **Multi-tenant from day one** — `org_id` on every row, enforced via query scoping; per-org encryption keys for audio at rest.
- **Swap points (buy now → own later), each behind a stable interface:**

| Interface | Bought today | Owned later (when justified) |
|---|---|---|
| `Transcriber` | Google/Azure/Groq cascade | fine-tuned CS model (corpus will exist by then) |
| `Diarizer` | pyannote (open) | custom fusion |
| `OcrEngine` | PaddleOCR | — |
| `LlmClient` | Claude API | provider-agnostic already |
| `PlatformAdapter` | official platform APIs | bot fleet (Vexa/Attendee fork) if needed |
| `ActionConnector` | per-tool REST | unified connector framework |

Swapping any implementation touches **zero** downstream code. This is what "buy now, own later" costs when designed in from the start: nothing.

---

## Capture layer

**Key realization:** we don't want the platforms' transcripts — we want their **audio** and **speaker labels**. Their transcripts can't handle code-switching (our job); their capture infrastructure is free, official, and unbreakable by UI changes.

| Platform | Primary (no bot) | Audio | Identity |
|---|---|---|---|
| Zoom | ⭐ RTMS WebSocket (live) or Cloud Recording per-participant files | **per-participant** | exact |
| Meet | ⭐ Meet REST API, pre-configured auto-recording + auto-transcript | mixed | transcript speaker labels ⊕ pyannote fusion |
| Teams | Graph API recordings + transcripts | mixed | transcript labels ⊕ fusion |

**Capture modes are a user choice** (org default + per-meeting override), because no single method fits every org: **A1** official real-time (Zoom RTMS) · **A2** official artifacts (the default) · **B** bot (Vexa/Attendee fork — deferred, only for orgs below required tier) · **C** desktop companion · **D** manual upload (cheapest onboarding: upload one recording, see real output before installing anything). Downstream consumes one normalized `capture_session`; weaker modes simply yield honestly lower confidence labels, never silent degradation.

Always disclosed — named participant, chat announcement, logged consent. No stealth capture under any framing.

**Implementation status:** Mode D upload is runtime-verified. Mode A2 Zoom Cloud Recording and Meet REST adapters are implemented and wired into the worker `acquire` stage through the `PlatformAdapter` interface; the worker persists roster rows, normalized audio tracks, per-participant attribution when available, and video/screen-share URIs for the screen stage. This path is unit-tested against fakes only; real OAuth/token providers and live platform smoke tests are still pending.

**Details preserved from research:** Meet REST needs Workspace Business Standard+; Teams Graph transcript access is admin-gated from 29 Jul 2026 (detect at onboarding, fall back explicitly); Zoom RTMS commercial terms unconfirmed (verify week 1; Cloud Recording is the same-quality fallback); store all audio as FLAC forever — every meeting stays re-transcribable as ASR improves, and the corpus is the moat.

### Screen → keyframes
Sample 1–2 fps → dHash + SSIM delta → debounce (cursor noise, playing video, mid-transition frames) → keyframe with validity interval → PaddleOCR + Haiku caption + regex entities (ticket IDs, URLs, stack traces).
**Speech↔screen grounding:** utterance × keyframe by temporal overlap, boosted by lexical match (utterance says "PAY-442", OCR contains `PAY-442` → high-precision link). Answers *"what were they looking at when this was decided?"* — no competitor has this.

### Coverage honesty (first-class feature)
Health heartbeat → `coverage_interval` rows (`ok/degraded/missing` + reason). Knowledge overlapping a gap is flagged; reports state gaps plainly ("11:42–11:44 audio not captured; knowledge from this interval may be incomplete"). Canary meeting on a schedule detects platform breakage; nothing fails silently.

---

## ASR track — buy everything, orchestrate the gap

**No model training.** No GPU, no fine-tune, no ML research track — the largest schedule risk in the original brief, deleted. What vendors can't sell (Sinhala code-switching — verified: Azure explicitly unsupported for `si-LK`, Google one-language-per-request, nobody else has Sinhala at all) is engineered around:

```
audio → VAD → pyannote diarization (language-independent)
                ↓
        VoxLingua107 language-ID per span (~0.5–1s windows, merge adjacent)
                ↓
   ┌────────────┼────────────────┐
 English      Sinhala          Tamil
 Groq        Google ⇄ Azure   Google ⇄ Azure (+ Speechmatics en_ta candidate)
 $0.036/hr   (primary→fallback, auto-failover on error/low confidence)
   └────────────┼────────────────┘
                ↓ stitch on original timestamps
   LLM repair pass — context vendors never see:
   roster (names) · org glossary (terms) · keyframe OCR (ticket IDs) · bilingual fluency (switch boundaries)
                ↓
        final transcript, per-utterance lang_tags + confidence
```

- **Google + Azure locked as the Sinhala/Tamil pair** — the only two vendors on Earth serving Sinhala; weeks 1–3 rank primary vs fallback on a gold set, loser becomes automatic failover (also hedges vendor outage on our hardest language).
- **Free-tier funding:** Google $300 credit (~312 hrs chirp_2) + Azure F0/credit + Groq 240 hrs/mo ongoing → bake-off costs <$5, first pilot months nearly free.
- **Known cost:** the cascade is weakest exactly at switch points (VAD+LID+ASR errors compound there). Eval reports **switch-point accuracy separately** so this is tracked, never hidden in average WER. The LLM repair layer is the mitigation and the quality lever.
- **Gold set (weeks 1–3):** 5–10 hrs real consented SL meeting audio, hand-transcribed. Permanent regression asset. Metrics: WER per language, switch-point accuracy, entity accuracy, DER.
- **Door kept open at zero cost:** corrections accrue into the only si-ta-en CS corpus in existence. If the cascade proves insufficient at scale, training can be revisited with evidence and data in hand (reference kept: IndicWhisper base, balanced fine-tuning per Polyglot-Lion, Indo-Aryan transfer for Sinhala).

**Cost:** Sinhala is the expensive span (Google $0.96/hr) but routing sends only si-spans there and everything else to Groq at $0.036 — blended well under $0.30/hr. 10 pilot teams ≈ 600 hrs/mo ≈ low hundreds of dollars, pure opex, scales to zero when nobody meets.

---

## Data model (core tables)

`org` · `person` (aliases — "Nimal" resolves across meetings) · `calendar_connection` · `meeting` · `capture_session` (mode, FSM state, disclosure log) · `participant` · `coverage_interval` · `utterance` (span, person, text, `lang_tags[]`, asr_confidence, attribution_confidence) · `keyframe` (validity interval, image, phash, ocr_text, caption, entities) · `utterance_keyframe` (grounding link + score) · `knowledge_item` (type: decision/commitment/requirement/blocker/question/fact; statement, owner, due, **lifecycle_state**, **confidence**, rationale, embedding) · `knowledge_evidence` (item → utterance/keyframe) · `knowledge_edge` (`SUPERSEDES|CONTRADICTS|CONTINUES|RECURS|RESOLVES` + rationale) · `proposed_action` (always `pending_approval`) · `correction` (consent flag) · `consent_record` · `audit_log`

Design note: lifecycle **state** lives on items (`NEW/RECURRING/REOPENED/RESOLVED/SUPERSEDED`); **relations** are edges between items. Conflating them (as the brief's flat list implied) would make cross-meeting traversal impossible.

---

## Build order (solo-dev weeks)

| Phase | Weeks | Deliverable |
|---|---|---|
| **0. Foundations** | 1–2 | Monorepo, schema, FSM orchestrator, R2, all six swap-point interfaces |
| **0b. ASR baseline** | 1–3 | Gold set + eval harness; rank Google vs Azure; freeze regression baseline |
| **1. Capture** | 3–6 | **Mode D upload** runtime-verified → Mode A2 artifacts wired into `acquire` for Meet REST + Zoom Cloud Rec (fake-tested, not live OAuth/API-tested) → A1 RTMS. Calendar watch, disclosure, coverage telemetry |
| **2. ASR cascade** | 4–7 | VAD + LID + routing + failover + LLM repair; correction UI + glossary (flywheel live) |
| **3. Understanding** | 7–12 | Keyframes, OCR/VLM, speech↔screen grounding, five agents, evidence + confidence |
| **4. Memory + Chat** | 11–15 | Lifecycle edges, hybrid retrieval, **org-memory chat with evidence chips** — MongoDB acceptance test passes |
| **5. Product + Automation** | 14–18 | Report UI, coverage display, approval UI; follow-up email, Slack recap, Jira/GitHub task automations |
| **6. Expansion** | 18+ | Teams Graph adapter, bot fallback (fork Vexa/Attendee), CRM field-sync, pilot onboarding |

**First sellable slice — end of Phase 4 (~4 months):** Zoom + Meet capture, tri-lingual transcription, evidence-graded knowledge, cross-meeting memory, chat. Phase 5 reaches automation parity with Fireflies/Fathom on the workflows that matter.

**Parallel workstream — consent & compliance:** Sri Lanka PDPA (2022) + platform ToS + recording-consent law. Disclosure, join policy, retention, export/deletion built in from Phase 0. Requires local legal review before pilot — the plan flags requirements, it does not assert what the law permits.

---

## Verification

- **E2E replay:** feed a known code-switched recording through Mode D, assert utterances, keyframes, knowledge items, and report against ground truth; later replay the same file through A2 artifacts path.
- **Coverage integrity:** kill audio mid-recording → assert gap row, flagged items, explicit report disclosure.
- **Grounding:** utterance naming an on-screen ticket links to the correct keyframe.
- **Anti-hallucination:** schema test proves Report input contains no transcript text; every report claim resolves to a `knowledge_evidence` row.
- **ASR regression:** WER + switch-point + entity accuracy against the frozen gold set on every routing/vendor change.
- **Acceptance:** seed the three-meeting Postgres→blocker→MongoDB arc; ask "why are we using MongoDB?"; assert the answer traverses all three with speaker + transcript + screen evidence.
- **Automation gate:** proposed actions never execute without an approval record — asserted at the DB constraint level.

---

## Risks

| Risk | Mitigation |
|---|---|
| Only two Sinhala vendors exist; one fails or cuts quota | Locked primary/fallback pair with auto-failover; FLAC retention allows re-transcription |
| Cascade quality at switch points disappoints | Tracked explicitly from week 3; LLM repair is the lever; training door stays open with corpus accumulating |
| Org tier gates official capture (Meet Business Standard+, Teams admin toggle from 29 Jul 2026) | Detect at onboarding, route to best available mode, state the limitation |
| Zoom RTMS terms unworkable | Confirm week 1; Cloud Recording API is same-quality fallback |
| Fireflies/Otter add si/ta support | Their architecture (no cross-meeting context, no evidence grounding, no screen linking) is the moat, not the language list; corpus compounds meanwhile |
| LLM repair cost creep | Haiku for routine repair, Sonnet only for low-confidence segments; per-org budget caps |
| Scope is 12+ months | Phase 4 is a sellable slice at ~4 months; everything after is expansion |
