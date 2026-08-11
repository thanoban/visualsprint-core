# Speaker Identity & Per-Person Accountability

The differentiating feature: not just *what* was decided, but **who committed to it,
whether they did it, and whether they keep saying the same thing without doing it.**

Competitors (Otter, Read.ai, Fireflies) label speakers. Few track a *person's*
commitments across meetings as a lifecycle. This document plans that capability.

## The core misconception to avoid

No meeting platform hands out per-participant audio streams. Zoom RTMS, Meet, and
Teams all deliver **mixed audio**. Competitors do not have a secret data source —
they run **diarization** (separating "who spoke when" from one mixed track) and then
match those voices to names. Mixed audio is the normal input, not a limitation.

Correction to an earlier framing: "mixed audio only" was never the blocker. The
blocker is that our diarizer is not wired into the pipeline.

## What already exists (verified, not assumed)

| Capability | Location | State |
|---|---|---|
| `Diarizer` swap-point interface | `app/interfaces/diarizer.py` | ✅ complete |
| pyannote 3.1 adapter | `app/adapters/diarizer_pyannote.py` | ✅ complete, HF-token gated |
| Platform speaker labels | `app/interfaces/platform.py::SpeakerLabelSpan` | ✅ Meet + Teams adapters return them |
| Participant roster | `app/interfaces/platform.py::RosterEntry` | ✅ all A2 adapters return it |
| Commitment ownership | `KnowledgeItem.owner_person_id` | ✅ modelled |
| "Saying it again" | `LifecycleState.RECURRING`, `KnowledgeEdge.RECURS` | ✅ modelled |
| "Actually did it" | `LifecycleState.RESOLVED`, `KnowledgeEdge.RESOLVES` | ✅ modelled |
| "Came back again" | `LifecycleState.REOPENED` | ✅ modelled |
| Contradiction across meetings | `KnowledgeEdge.CONTRADICTS` | ✅ modelled |
| pgvector for similarity search | `KnowledgeItem.embedding` | ✅ installed and working |

The accountability schema is largely built. What is missing is reliable `person_id`
flowing into it.

## The three real gaps

### Gap 1 — diarization is never called

`STAGES` (`app/orchestrator/pipeline.py`) is
`acquire → transcribe → screen → understand → verify → remember → propose → report`.
There is no `diarize` stage. Consequently every mixed-audio mode (Mode D upload,
Meet, Teams, and Zoom RTMS — which accumulates one mixed stream) writes
`Utterance.person_id = None` and `attribution_confidence = 0.0`
(`app/orchestrator/worker.py`, `transcribe` handler).

Only Zoom *Cloud Recording* per-participant tracks (Mode A2) currently produce exact
attribution.

### Gap 2 — no voice identity across meetings

`Person` holds `display_name`, `email`, `aliases` — no voiceprint. Diarization alone
yields session-local anonymous clusters (`SPEAKER_00`), so "SPEAKER_00" in this
week's meeting cannot be connected to the same human last week. Cross-meeting
accountability requires that link.

### Gap 3 — owner resolution only works when a name is spoken

`app/agents/context.py::_resolve_owner` matches an LLM-extracted `owner_hint` string
against `Person.display_name`/`aliases`. This works for *"Nimal will fix the payment
gateway"* and fails for **"I'll fix the payment gateway"** — the most common way
people actually commit to work. With no name in the sentence, the commitment gets no
owner.

**This is the gap that most directly blocks the differentiating feature**, and speaker
attribution is exactly what closes it: the speaker of the utterance *is* the owner
when the sentence says "I".

## Phase A — wire diarization

Goal: every utterance carries a speaker cluster, on every capture mode.

**Pipeline change** — insert one stage:

```
acquire → diarize → transcribe → screen → understand → verify → remember → propose → report
```

`diarize` runs before `transcribe` so `transcribe` can attach identity as it creates
`Utterance` rows, rather than requiring a second update pass.

**New tables** (SQLAlchemy model + Alembic migration, per CLAUDE.md conventions):

```python
class SpeakerTurnRow:          # __tablename__ = "speaker_turn"
    id, org_id, capture_session_id
    start_s: float
    end_s: float
    cluster_id: str            # "SPEAKER_00" — anonymous, session-local
    confidence: float

class SessionSpeaker:          # __tablename__ = "session_speaker"
    """One row per distinct voice in a session — where identity is resolved."""
    id, org_id, capture_session_id
    cluster_id: str            # "SPEAKER_00"
    person_id: str | None      # resolved identity, null until fusion succeeds
    embedding: Vector(N)       # centroid voiceprint for this cluster
    resolution_method: str     # "roster" | "voiceprint" | "manual" | "unresolved"
    confidence: float
```

Splitting turns from speakers keeps one embedding per voice rather than one per turn.

**Handler behaviour** (`_handle_diarize`):
- Skip entirely when `AudioTrack.participant` is set (Zoom per-participant tracks —
  attribution is already exact; diarization would add noise).
- Otherwise run `PyannoteDiarizer.diarize()` on the mixed track.
- Persist turns + one `SessionSpeaker` per cluster.
- Idempotent: delete-then-insert keyed on `capture_session_id`, matching every other
  stage's re-run safety.

**`transcribe` change**: for each utterance, assign the cluster with maximum temporal
overlap; set `attribution_confidence` from overlap ratio × diarization confidence
rather than a flat `0.0`. Honest degradation — a 55%-overlap assignment must not
claim the same confidence as a Zoom exact-identity track.

**Graceful degradation**: pyannote requires `VS_HUGGINGFACE_TOKEN` (already wired
into the `agents` service). If unavailable, `diarize` must log and pass through
without failing the session — same policy as the optional VLM captioner.

## Phase B — identity fusion (cluster → real person)

Goal: `SPEAKER_00` becomes *Nimal*, consistently, across every future meeting, with
**no manual enrollment step**.

**Schema**: `Person.voiceprint: Vector(N) | None`, plus `voiceprint_sample_count` so
repeat sightings refine the centroid (running mean) instead of overwriting it.

`N` = the pyannote embedding dimensionality. **Must be verified empirically against
the real model before the migration is written** — do not assume 192/256/512 from
memory. Same rule that produced the `chirp_2` ⇄ Azure vendor verification.

**Resolution order** (first match wins, and each records its `resolution_method` so
the report can state *how* it knows):

1. **Platform roster labels** — Meet and Teams already return `SpeakerLabelSpan`
   (`display_name` + timing). Overlap those spans with diarization clusters; a
   confident majority match names the cluster and *enrolls* its voiceprint against
   that `Person`. This is the zero-effort automatic path and covers the platforms
   where auto-capture matters most.
2. **Known voiceprint** — cosine similarity against `Person.voiceprint` within the
   same org (pgvector, already available), above a tuned threshold. This is what
   carries identity across meetings once someone has been seen.
3. **Single-participant inference** — a 1:1 meeting where the roster has exactly two
   people and one is the connected account owner.
4. **Unresolved** — leave `person_id` null and say so in the report. Never guess a
   name; an incorrect attribution in a performance-tracking product is worse than an
   admitted unknown (CLAUDE.md rule 6's principle applied to identity).

**Correction path**: the existing `/meetings/[id]/correct` page gains a "who is this
speaker?" control. Optional, not required — corrections re-enroll the voiceprint, so
accuracy compounds without ever blocking automatic operation.

**Multi-tenancy**: voiceprint matching is always `WHERE person.org_id = :org_id`.
A voiceprint must never match across orgs — that is a privacy boundary, not a tuning
detail.

## Phase C — per-person accountability (the differentiator)

**C1 — first-person commitment ownership.** In `app/agents/context.py`, when a
candidate's `owner_hint` is absent or self-referential ("I", "I'll", "me", "we"),
resolve the owner from the *speaker* of the source utterance
(`Utterance.person_id`). This alone converts the majority of real commitments from
ownerless to owned. Requires Phase A + B; no schema change.

**C2 — per-person history API + view.** For a given `Person`:
- open commitments (`lifecycle_state IN (NEW, REOPENED, RECURRING)`)
- delivered (`RESOLVED`)
- **repeat-without-delivery** — items linked by `KnowledgeEdge.RECURS` that never
  reached `RESOLVED`. This is the "keeps saying the same thing" signal, and it is
  computable from data the schema already stores.
- contradictions (`KnowledgeEdge.CONTRADICTS`) involving their statements

**C3 — person-targeted actions.** Jira/Linear task creation assigns to the resolved
owner; Slack recap can @-mention the actual committer; the existing deterministic
`action_triggers.py` sweeps (recurring-blocker, due-date-approaching) become
per-person rather than per-org.

**Evidence discipline is unchanged.** Every per-person claim stays subject to the
existing rules: Report Intelligence never sees raw transcript (rule 2), verification
never sees the extractor's reasoning (rule 3), and any claim overlapping a coverage
gap is flagged. A performance-tracking feature raises the cost of a hallucinated
attribution, so these constraints matter more here, not less.

## Dependency on automatic capture

This plan assumes meetings arrive without manual upload. Current state of that path:

| Path | State |
|---|---|
| Calendar watch (Google + Microsoft) | ✅ built, wired into worker poll loop |
| Microsoft OAuth client | ✅ wired into production |
| Google OAuth client | ❌ **not created** — blocks Google Calendar + Meet auto-capture |
| Zoom RTMS live capture (incl. instant meetings) | ✅ built + credentials in production, ⚠️ never tested against a real live meeting |
| Zoom RTMS screen/video | ❌ **not built** — RTMS client handles `MEDIA_DATA_AUDIO` only, so live Zoom sessions currently produce no keyframes/OCR/screen evidence |

The Google OAuth client is a console task for the account owner. The Zoom RTMS video
gap is real engineering work and is *not* covered by this plan — tracked separately.

## Build order

1. **A** — diarization stage + schema + tests. Unblocks everything; mechanical.
2. **B** — voiceprint schema (after verifying embedding dimension), roster fusion,
   cross-meeting matching, correction UI.
3. **C** — first-person ownership, per-person view, person-targeted actions.

Phase A is independently useful: even anonymous "Speaker 1 / Speaker 2" separation
improves every transcript and report immediately.

## Verification checklist before claiming this works

- [ ] pyannote embedding dimensionality confirmed against the real model
- [ ] Diarization accuracy checked on **Sinhala/Tamil/English code-switched** audio,
      not only English — pyannote is language-agnostic in principle, but this is the
      project's actual workload and the claim needs evidence, not assumption
- [ ] Cross-meeting re-identification tested with the same speaker in two sessions
- [ ] Voiceprint isolation across orgs verified by test
- [ ] Attribution confidence honestly reflects overlap quality (no flat 1.0)
