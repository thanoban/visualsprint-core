# Participant Intelligence — per-person accountability across meetings

The differentiator. Competitors transcribe a meeting and label speakers. This tracks
**a person across meetings**: what they decided, what they committed to, whether it
got done, and whether the same thing keeps coming back unresolved.

Prerequisite: [08-speaker-identity.md](08-speaker-identity.md). Phase A (speaker
separation) shipped 2026-08-11. Phase B (names across meetings) is the first section
below.

## The real problems this solves

Observed failure modes in companies running recurring meetings. Each maps to
something the existing schema can actually measure — no new data source needed.

| Problem | Why it persists | What we measure |
|---|---|---|
| "Who owns this?" — decisions made, nobody assigned | Verbal commitments vanish; notes lose the speaker | `KnowledgeItem.owner_person_id` resolved from **who spoke it** |
| Same blocker every standup, no progress | No memory across meetings | `KnowledgeEdge.RECURS` chain never reaching `RESOLVED` |
| People commit, nothing happens, no trail | Nobody re-reads last week's notes | `COMMITMENT` in `NEW`/`REOPENED` past `due_at` |
| Decisions silently contradict earlier ones | Nobody remembers the earlier one | `KnowledgeEdge.CONTRADICTS` |
| Decisions get re-litigated repeatedly | The rationale wasn't captured with the decision | `SUPERSEDES` chain + evidence per link |
| New joiners can't learn why things are the way they are | History lives in people's heads | Decision chain + `KnowledgeEvidence` (transcript span + screen) |
| Quiet contributors' input is lost | Loud voices dominate the summary | Per-person contribution recorded regardless of volume |
| Status updates repeat what was already said | No cross-meeting dedupe | `CONTINUES`/`RECURS` detection |
| Action items never reach Jira/Slack | Manual copying | `ProposedAction` + approval + connectors (already built) |

The through-line: **a meeting is not the unit of value — a commitment's lifecycle
across meetings is.** That's the product.

## What we can honestly measure (and what we must not claim)

The schema already carries the right primitives:

- `KnowledgeType`: `DECISION`, `COMMITMENT`, `REQUIREMENT`, `BLOCKER`, `QUESTION`, `FACT`
- `LifecycleState`: `NEW`, `RECURRING`, `REOPENED`, `RESOLVED`, `SUPERSEDED`
- `KnowledgeEdge`: `SUPERSEDES`, `CONTRADICTS`, `CONTINUES`, `RECURS`, `RESOLVES`
- `KnowledgeEvidence`: every item traceable to transcript span + keyframe
- `Confidence`: `VERIFIED`, `PARTIALLY_SUPPORTED`, `AMBIGUOUS`, `UNSUPPORTED`

### Fairness constraints — design requirements, not disclaimers

A per-person scoring feature built carelessly on this data would be both unfair and
commercially damaging. These constraints are part of the spec:

1. **Never score talk-time as contribution.** Talk-time measures dominance, not value.
   A product whose "top performer" is whoever talks most is worse than useless, and
   competitors already ship that metric. We deliberately do not.

2. **ASR quality varies by language — scoring must not inherit that bias.** This is a
   Sinhala/Tamil/English product. If Sinhala ASR is weaker than English ASR, a
   naive score penalises Sinhala speakers for the transcriber's limitations, not
   their work. **Any per-person metric must be computed only over items whose
   `Confidence` is `VERIFIED` or `PARTIALLY_SUPPORTED`, and any per-person view must
   disclose how much of that person's speech fell in a coverage gap or a
   low-confidence ASR span.** This follows directly from CLAUDE.md rule 6 (capture
   gaps are data, not silence) applied to people.

3. **Blocked ≠ failed.** A commitment that missed its date because another person's
   dependency slipped must not read as that person's failure. Where a `BLOCKER` item
   links to a commitment, surface it alongside — never a bare "missed" count.

4. **Attribution confidence is displayed, never hidden.** An item whose owner came
   from a 0.6-confidence voice match must show that. Silent false attribution in an
   accountability product is the single worst failure mode available to us.

5. **This is a team-improvement tool, not a surveillance tool.** Metrics are framed
   as "what's stuck / what needs help", not employee ranking. That framing is also
   the more defensible product position and the more sellable one.

## Phase B — identity across meetings

Turn `SPEAKER_00` into a named person, consistently, forever, with no manual step.

**Schema**
```python
Person.voiceprint: Vector(N) | None          # enrolled centroid embedding
Person.voiceprint_sample_count: int = 0      # running mean, refines over time
SessionSpeaker.embedding: Vector(N) | None   # this session's cluster centroid
```
`N` **must be read from the real pyannote embedding model before writing the
migration** — not assumed. Same discipline that produced the verified ASR vendor pair.

**Resolution order** — first confident match wins; `resolution_method` records which:

1. **`ROSTER`** — Meet/Teams already return `SpeakerLabelSpan` (`display_name` +
   timing) and every A2 adapter returns `RosterEntry`. Overlap those spans against
   diarization clusters; a clear majority names the cluster **and enrolls its
   voiceprint**. Zero user effort, and it bootstraps identity on the platforms where
   automatic capture matters most.
2. **`VOICEPRINT`** — cosine match against `Person.voiceprint` within the same org
   (pgvector, already installed and working). This is what carries a person from one
   meeting into the next.
3. **1:1 inference** — a two-person meeting where one is the connected account owner.
4. **`UNRESOLVED`** — leave null and say so. Never guess a name.

**Correction path** — `/meetings/[id]/correct` gains a speaker picker. Corrections
set `resolution_method = MANUAL` and re-enroll the voiceprint, so accuracy compounds.
Optional; never blocks automatic operation.

**Hard constraint**: voiceprint matching is always scoped `WHERE person.org_id =
:org_id`. Cross-org matching is a privacy breach, not a tuning parameter.

## Phase C — per-person accountability

**C1 — first-person ownership (the highest-value single change).**
`app/agents/context.py::_resolve_owner` currently only resolves a *spoken name*
("Nimal will fix X"). The most common real commitment — **"I'll fix X"** — resolves
to nobody today. With Phase B, when `owner_hint` is absent or self-referential
(I / I'll / me / we), take the owner from the **speaker of the source utterance**
(`Utterance.person_id`). No schema change; converts the majority of real commitments
from ownerless to owned.

**C2 — person timeline API.** `GET /api/v1/orgs/{org_id}/people/{person_id}/timeline`

Per person, grouped by meeting, newest first — this is literally "previous meeting
what he said / this meeting what he said":
- items they own or stated, per meeting, with type and lifecycle state
- the `RECURS`/`CONTINUES` edge linking this meeting's item to the earlier one
- evidence chip (transcript span + keyframe thumbnail) per item
- `attribution_confidence` on every row

**C3 — person-targeted actions.** Jira/Linear assignment to the resolved owner;
Slack recap @-mentions the actual committer; `action_triggers.py`'s deterministic
sweeps (recurring-blocker, due-date-approaching) become per-person.

## Phase D — analytics and graphs

All derived from Phase C data; no new capture, no new vendor.

**D1 — the metrics that are actually defensible**

| Metric | Definition | Why it's honest |
|---|---|---|
| **Follow-through rate** | `RESOLVED` ÷ (all commitments owned, past due) | Measures delivery, not volume |
| **Open commitments** | owned, `NEW`/`REOPENED`, not past due | Workload, not blame |
| **Overdue** | owned, past `due_at`, not `RESOLVED` | Shown *with* linked blockers |
| **Repeat-without-progress** | `RECURS` chain length ≥ 2, never `RESOLVED` | The "keeps saying it" signal — the genuinely novel one |
| **Decision authorship** | `DECISION` items they stated | Contribution ≠ talk-time |
| **Unblocking** | `BLOCKER`s they `RESOLVES`-edge closed | Rewards helping others |
| **Contradiction rate** | items in `CONTRADICTS` edges | Detects mixed signals early |

Deliberately excluded: talk-time, word count, sentiment scoring, "engagement" —
noise dressed as insight, and unfair across languages.

**D2 — graphs**
- Follow-through over time (per person and team) — line
- Commitment funnel: stated → in-flight → resolved / lapsed
- Recurring-blocker heat map: blocker × meeting, the visual "this never moves"
- Decision evolution: `SUPERSEDES` chain as a timeline — *"what changed and why"*
- Team load: open commitments per person — spot overload, not slackers

**D3 — improvement tracking (explicitly asked for)**
- *"What decisions improved"* → walk `SUPERSEDES` chains; each hop is a revision with
  its own evidence and rationale. Renders as: original → what changed → current.
- *"What got done"* → `RESOLVED` items per meeting per person, evidence-linked.
- *"Improvement per meeting"* → change in follow-through rate between consecutive
  meetings of the same recurring series (`Meeting.external_calendar_event_id`
  already links a recurring series).

## Phase E — proactive intelligence

Where this stops being a report and starts being useful before the meeting.

- **Pre-meeting brief** — "Last time, 3 commitments were made; 1 is done, 2 overdue.
  This blocker has recurred 4 times." Generated from existing data ahead of a
  calendar-detected meeting.
- **Stale-commitment nudge** — deterministic sweep (already exists in
  `action_triggers.py`), now per-person.
- **Contradiction alert at capture time** — when a new `DECISION` contradicts a
  standing one, flag during the report, not months later.
- **Agenda suggestion** — unresolved recurring items ranked by staleness.

## Build order

| Step | Work | Depends on |
|---|---|---|
| B1 | Verify pyannote embedding dim; add voiceprint schema + migration | — |
| B2 | Cluster-centroid embedding extraction in `diarize` | B1 |
| B3 | Roster-label fusion (Meet/Teams `SpeakerLabelSpan`) + enrollment | B2 |
| B4 | Cross-meeting voiceprint matching (pgvector) | B2 |
| B5 | Speaker correction UI + re-enrollment | B3 |
| C1 | First-person commitment ownership | B3/B4 |
| C2 | Person timeline API + page | C1 |
| C3 | Person-targeted Jira/Slack/Linear actions | C1 |
| D1 | Metrics computation (confidence-filtered) | C2 |
| D2 | Graphs on the person + team pages | D1 |
| D3 | Decision-evolution and improvement views | D1 |
| E | Pre-meeting brief, nudges, contradiction alerts | D1 |

B1–B4 are the load-bearing part; everything after is derived data and UI.

## Verification checklist — what must be proven, not assumed

- [ ] pyannote embedding dimensionality read from the real model
- [ ] Diarization + identity accuracy measured on **Sinhala/Tamil/English
      code-switched** audio, not English-only. This is the actual workload and the
      one most likely to behave differently from published benchmarks.
- [ ] Same speaker re-identified across two separate sessions
- [ ] Voiceprint isolation across orgs proven by test
- [ ] Per-person metrics verified to exclude low-confidence/coverage-gap items
- [ ] A blocked-but-not-failed commitment renders with its blocker, not as a bare miss
