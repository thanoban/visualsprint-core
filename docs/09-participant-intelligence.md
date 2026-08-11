# Participant Intelligence — per-person accountability across meetings

The differentiator. Competitors transcribe a meeting and label speakers. This tracks
**a person across meetings**: what they decided, what they committed to, whether it
got done, and whether the same thing keeps coming back unresolved.

Prerequisite: [08-speaker-identity.md](08-speaker-identity.md). Phase A (speaker
separation) shipped 2026-08-11 and is live in production.

**Status: planned, not yet implemented.** This document is the design; nothing in
Phases B–F below has been coded. The full plan (with file-level detail, risk analysis,
and step dependencies) was reviewed and approved 2026-08-11; this doc is its durable
record in the project's own docs, superseding the earlier draft of this file.

## Three concrete defects this plan fixes

Verified in the actual code, not assumed:

1. **`app/agents/context.py::_resolve_owner` (lines 91-103) only matches a spoken
   name.** *"I'll fix the payment gateway"* → `owner_person_id = None`. Most real
   commitments are self-referential, not named, and get no owner today. It also
   returns the **first** name match, so two people named Nimal silently produce a
   wrong owner.
2. **A `RESOLVES` edge never closes the item it resolves.** `app/agents/memory.py:226`
   writes `lifecycle_state` only for the *new* item, and `run_memory_intelligence`
   only ever processes the current session's items. The original commitment stays
   `NEW`/`RECURRING` forever — *"did he actually do it?"* is unanswerable even with
   perfect speaker attribution.
3. **`Person` has no link to `User`/`OrgMember`.** A logged-in user cannot see "my
   commitments" — no join path exists between who is logged in and which `Person`
   row is them.

## The real problems this solves

Observed failure modes in companies running recurring meetings. Each maps to
something the existing schema can actually measure — no new data source needed.

| Problem | Why it persists | What we measure |
|---|---|---|
| "Who owns this?" — decisions made, nobody assigned | Verbal commitments vanish; notes lose the speaker | `KnowledgeItem.owner_person_id` resolved from **who spoke it**, not just who was named |
| Same blocker every standup, no progress | No memory across meetings | `KnowledgeEdge.RECURS` chain never reaching `RESOLVED` |
| People commit, nothing happens, no trail | Nobody re-reads last week's notes | `COMMITMENT` in `NEW`/`REOPENED` past `due_at` |
| Decisions silently contradict earlier ones | Nobody remembers the earlier one | `KnowledgeEdge.CONTRADICTS` |
| Decisions get re-litigated repeatedly | The rationale wasn't captured with the decision | `SUPERSEDES` chain + evidence per link |
| New joiners can't learn why things are the way they are | History lives in people's heads | Decision chain + `KnowledgeEvidence` (transcript span + screen) |
| "Done" claims aren't checked against reality | Nobody cross-references the ticket | Work-tracker status sync (Phase F) |
| Status updates repeat what was already said | No cross-meeting dedupe | `CONTINUES`/`RECURS` detection |
| Action items never reach Jira/Slack | Manual copying | `ProposedAction` + approval + connectors (already built) |

The through-line: **a meeting is not the unit of value — a commitment's lifecycle
across meetings and into real systems of record is.** That's the product.

## What we can honestly measure (and what we must not claim)

The schema already carries the right primitives:

- `KnowledgeType`: `DECISION`, `COMMITMENT`, `REQUIREMENT`, `BLOCKER`, `QUESTION`, `FACT`
- `LifecycleState`: `NEW`, `RECURRING`, `REOPENED`, `RESOLVED`, `SUPERSEDED`
- `KnowledgeEdge`: `SUPERSEDES`, `CONTRADICTS`, `CONTINUES`, `RECURS`, `RESOLVES` (plus
  a new `BLOCKS` — see Phase C)
- `KnowledgeEvidence`: every item traceable to transcript span + keyframe
- `Confidence`: `VERIFIED`, `PARTIALLY_SUPPORTED`, `AMBIGUOUS`, `UNSUPPORTED`

### Fairness constraints — design requirements, not disclaimers

A per-person feature built carelessly on this data would be both unfair and
commercially damaging. These constraints are part of the spec:

1. **No per-person performance score, of any kind.** Decided explicitly: talk-time
   would systematically penalise speakers whose ASR confidence is lower — a real bias
   in a Sinhala/Tamil/English product — and "who talked most" rewards dominance, not
   value. **Participant activity is represented as an interaction map (Phase E),
   never a score or ranking.**

2. **ASR quality varies by language — no metric may inherit that bias.** Any
   per-person metric is computed only over items whose `Confidence` is `VERIFIED` or
   `PARTIALLY_SUPPORTED`, and every per-person view discloses how much of that
   person's speech fell in a coverage gap or a low-confidence ASR span. Follows
   directly from CLAUDE.md rule 6 (capture gaps are data, not silence) applied to
   people.

3. **Blocked ≠ failed.** A commitment that missed its date because another person's
   dependency slipped must not read as that person's failure. Where a `BLOCKER` item
   links to a commitment, surface it alongside — never a bare "missed" count.

4. **Attribution confidence is displayed, never hidden.** An item whose owner came
   from a 0.6-confidence voice match must show that. Silent false attribution in an
   accountability product is the single worst failure mode available to us.

5. **An ownerless commitment is never defaulted to its speaker.** *"The gateway needs
   fixing"* is not a commitment by whoever said it. Ownership from speech requires an
   explicit self-reference ("I'll...", "මම...", "நான்...") or an explicit model signal
   that the speaker is committing themselves — never an absence of a named owner.

6. **This is a team-improvement tool, not a surveillance tool.** Views are framed as
   "what's stuck / what needs help", not employee ranking. That framing is also the
   more defensible product position and the more sellable one.

## Phase B — identity across meetings

Turn `SPEAKER_00` into a named person, consistently, forever, with no manual step.

**Schema** (columns already added to the model, no migration written yet):
```python
Person.voiceprint: Vector(512) | None         # enrolled centroid embedding
Person.voiceprint_sample_count: int = 0
Person.voiceprint_reliable: bool = True        # false when contributing embeddings disagree too much
SessionSpeaker.embedding: Vector(512) | None   # this cluster's centroid, this session
SpeakerTurn.audio_track_id / SessionSpeaker.audio_track_id: FK audio_track.id
```
**512 verified empirically** — loaded the real `pyannote/embedding` model and read its
output shape directly, not assumed from documentation. Whether the raw output is
L2-normalized is not yet verified and must be checked before enrollment math is
written (unnormalized vectors bias a mean toward the longest one).

`audio_track_id` fixes a real collision: two mixed audio tracks in the same session
would both emit a cluster named `SPEAKER_00`, violating the current
`(capture_session_id, cluster_id)` uniqueness. Needs to become
`(capture_session_id, audio_track_id, cluster_id)`.

New table `PlatformSpeakerLabel(capture_session_id, start_s, end_s, display_name,
provider)` — Meet/Teams already hand back `SpeakerLabelSpan` (name + timing) but
`worker._persist_capture_artifacts` currently discards it. This table is the input
roster fusion needs and doesn't have today.

**Resolution ladder** — deterministic, first confident match wins,
`resolution_method` records which:

1. **`ROSTER`.** Overlap each diarized cluster against `PlatformSpeakerLabel` spans.
   Accept only when the dominant name covers ≥60% of the cluster's speech, beats the
   runner-up by ≥20 points, covers ≥5 labelled seconds, and resolves to exactly one
   `Person` (ambiguous name → no match, never a guess). Zero user effort, and it
   bootstraps identity on the platforms where automatic capture matters most.

   **Session-level sanity gate, checked before any roster matching:** if labelled
   spans cover less than 20% of total diarized speech, refuse roster fusion for the
   *entire* session and flag it. A constant clock offset between a platform's
   transcript timestamps and the audio file's own timeline would otherwise name every
   speaker confidently and *wrong* — the single most dangerous silent failure this
   design has to guard against, because it defeats the point of the feature while
   looking like it worked.

2. **`VOICEPRINT`.** Cosine similarity against every `Person.voiceprint` in the same
   org — matching is always scoped `WHERE person.org_id = :org_id`; cross-org
   matching is a privacy breach, not a tuning parameter. Candidates are matched
   **one-to-one** (greedy, highest similarity first; an already-assigned person is
   removed from the pool) so two clusters can't both claim the same person. Requires
   both a similarity threshold and a margin over the second-best candidate. This is
   what carries a person from one meeting into the next.

3. **1:1 inference** (opt-in, default **off** until measured) — exactly two clusters,
   exactly two rostered participants, one already resolved by roster or voiceprint.
   Never enrolls a voiceprint from this method; the identity is inferred, not heard.

4. **`UNRESOLVED`.** Leave `person_id` null and say so. Never guess a name.

**Enrollment is derived, not accumulated.** A voiceprint centroid is recomputed from
scratch each time as the mean of every `SessionSpeaker.embedding` ever resolved to
that person by `ROSTER` or manual correction — **not** a running mean updated
incrementally. A running mean inside a re-runnable pipeline stage isn't idempotent
(re-running the stage would count the same session twice) and can't be cleanly
reversed by a correction. Deriving from the underlying rows fixes both, and also
means a `VOICEPRINT`-only match never feeds the centroid it was matched against —
no self-reinforcing drift toward a wrong identity.

**Correction path** — `/meetings/[id]/correct` gains a speaker picker. A correction
sets `resolution_method = MANUAL`, triggers voiceprint recomputation for both the old
and new person, and re-attributes any utterances/ownership derived from that cluster.
Never blocks automatic operation.

## Phase C — commitment lifecycle closure

Independent of Phase B — works today, off names people already say, with no vendor
and no audio processing. Answers *"did he actually do it, or does it just keep coming
back?"*, which matters even before names are attached to every voice.

An item's state is **derived from its inbound edges**, never assigned by an agent —
CLAUDE.md rule 1 applied to lifecycle:

| Inbound edge from a newer item | Target becomes |
|---|---|
| `RESOLVES` | `RESOLVED` |
| `SUPERSEDES` | `SUPERSEDED` |
| `RECURS` / `CONTINUES` on an already-`RESOLVED` target | `REOPENED` |
| `RECURS` / `CONTINUES` otherwise | `RECURRING` |
| `CONTRADICTS` | no change — surfaced as a contradiction, not a closure |

**Only edges whose source item is `VERIFIED` or `PARTIALLY_SUPPORTED` count.** A
hallucinated or unsupported candidate must never be able to close a real commitment.
The derivation is a pure function over the edge table — it never reads the state it
writes, so running it any number of times converges to the same answer.

Runs at the end of `remember` (scoped to the session's new items and their edge
targets) and as a periodic org-wide sweep, because edges can also arrive from later
sessions, corrections, and backfills.

**New requirement this surfaces:** `EdgeKind.BLOCKS` (blocker → the commitment it
blocks) doesn't exist yet, and `_find_related` in `memory.py` currently excludes the
item's own session from candidates — so a blocker and the commitment it blocks,
stated in the *same* meeting (the common case), can never be linked today. Both need
fixing for "blocked ≠ failed" to actually work.

**"All milestones, until the last one"** — a bounded traversal over `KnowledgeEdge` in
both directions returns every hop from a commitment's first statement to its current
state, each with its meeting, date, owner, the edge's rationale, and its evidence.
This is the literal answer to *"what did he say before, what did he say this time"*.

## Phase D — first-person ownership

Depends on Phase B (needs `Utterance.person_id` populated) and benefits from Phase C
existing first, since ownership feeds the same lifecycle machinery.

The extraction agent already validates which utterances support a candidate item
(`supporting_utterance_ids`). Two additions let it say *who* is committing without
guessing a name:
- `owner_is_speaker: bool` — set when the speaker commits themselves, in any of the
  three languages ("I'll...", "මම...", "நான்...", including common romanized forms,
  since code-switched ASR often romanizes).
- `owner_utterance_id` — which utterance carries the commitment.

Deterministic resolution, never left to the model: a named hint resolves through
exact/alias matching (ambiguous name → no owner, fixing the existing first-match
bug); otherwise, when `owner_is_speaker` (or a detected self-reference token) is set,
the owner is the **speaker of that utterance** — `Utterance.person_id`, with
`Utterance.attribution_confidence` carried through as the ownership confidence.

**Confidence gate is structural.** Below a minimum confidence, the candidate person
is stored in a separate `owner_candidate_person_id` column that no metric ever reads,
instead of `owner_person_id`. This makes a low-confidence attribution
*unrepresentable* in any aggregate, rather than merely something each query is
supposed to remember to filter — the same reasoning as the DB-level
`ck_action_requires_approval` constraint elsewhere in this system.

A stored `owner_source` (spoken name vs. speaker-derived vs. manual) is what lets a
later speaker correction cleanly re-derive only the ownerships that came from voice,
without disturbing ones a name already fixed.

**Also fixes a live fairness bug while touching this code:** due dates are currently
parsed as ISO-8601 only, and the meeting's own date is never given to the model — so
"next week" / "ලබන සතියේ" / "அடுத்த வாரம்" never becomes a real `due_at`, silently
under-counting overdue commitments for whoever doesn't phrase a date in ISO. Passing
the meeting's date into the prompt and resolving relative dates against it fixes this
for all three languages at once.

## Phase E — person surfaces (no scoring)

**Person ↔ User linkage.** A `Person.user_id` link (nullable — many attendees never
log in) lets a logged-in user see their own commitments. Auto-linked only on verified
email match within the same org — never on display name, since name collisions are
exactly the failure mode this whole feature exists to avoid.

**Per-person view:** open/overdue/resolved commitments (with any linked blocker shown
alongside an overdue one, never a bare miss), decisions authored, the
repeat-without-progress signal (a `RECURS`/`CONTINUES` chain that never reaches
`RESOLVED`), and the timeline grouped by meeting — every metric computed only over
`VERIFIED`/`PARTIALLY_SUPPORTED` items, every payload carrying a disclosure of how
much of that person's speech was excluded and why.

**Interaction map — replaces any notion of a score.** Not rankings; relationships.
Nodes are people; edges are derived only from structured data already in the system:
who unblocks whom (a `BLOCKER` closed by another person's `RESOLVES`), who delegates
to whom (a commitment owned by someone other than who raised it), whose decisions
build on whose, and who tends to speak right after whom (turn-adjacency from
diarization). This is what "track participant interactions" means here — a map of
how the team actually works together, not a leaderboard.

**Existing talk-time engagement block** (`app/api/report.py::_build_engagement`,
already rendered on the report page): kept, but reframed as a capture-quality signal
("speech captured per speaker" — useful for spotting when identity fusion failed to
attribute someone at all), moved out of any "contribution" framing, and never
surfaced on a cross-meeting person or team view.

## Phase F — automatic work tracking (verify delivery against reality)

The strongest answer to *"did he actually do it?"* isn't what someone says in the next
meeting — it's whether the linked Jira/GitHub/Linear ticket actually closed. This loop
is already most of the way built and nobody closed it:

- A commitment already becomes a real `ProposedAction` → real Jira/GitHub/Linear issue
  once approved (`app/connectors/task_create.py`).
- Every one of those connectors already returns the created issue's ID
  (`ActionResult.external_id`) — **but nothing persists it.** Only the URL is stored
  today.
- The action row already links back to its source `KnowledgeItem`
  (`payload["evidence_item_ids"]`).

Closing it: persist `external_id`; add a `WorkTracker` swap-point interface
(`check_status(external_id) -> WorkStatus`) with Jira/GitHub/Linear adapters reusing
the same per-org OAuth connections the create-side connectors already use — no new
vendor, no new credentials; a periodic sweep polls executed actions whose linked item
isn't yet resolved; a closed ticket becomes a `WorkEvidence` row, and Phase C's
lifecycle derivation (not the poller directly) is what turns that into `RESOLVED` —
external evidence and meeting evidence close a commitment through the exact same rule.

**The genuinely new signal this produces:** a *claim/reality discrepancy* — someone
says "done" in standup while the linked ticket is still open. Surfaced neutrally as
*needs-reconciling*, never as an accusation, since it's just as often a stale ticket
as an untrue claim.

**Honest limit, stated up front:** only work that became a tracked ticket can be
verified this way. Work done outside a connected tracker is invisible to this signal,
so its absence must never be read as failure to deliver — per-person views
distinguish *verified done*, *claimed done*, and *no signal*, never collapsing the
last two into "not done".

## Build order

| Step | Work | Depends on |
|---|---|---|
| 0 | Verify pyannote embedding normalization (dimension already confirmed: 512) | — |
| 1 | Schema: voiceprint columns, `audio_track_id`, `platform_speaker_label`, owner columns, all new indexes — one migration | 0 |
| 2 | Persist platform speaker labels at `acquire` | 1 |
| 3 | Person↔User linkage + `/me` | 1 |
| 4 | Lifecycle closure + `EdgeKind.BLOCKS` + same-session blocker/commitment linking + sweep | 1 |
| 5 | `identify` pipeline stage (roster + voiceprint resolution ladder) | 1, 2 |
| 6 | First-person ownership + due-date fix | 1, 5 |
| 7 | Per-person query layer + lifecycle-chain traversal | 4, 6 |
| 8 | Person/team API + pages, engagement block reframed | 7 |
| 9 | Speaker correction UI + re-attribution cascade | 5, 8 |
| 10 | Automatic work tracking (external_id, WorkTracker, status sweep, WorkEvidence) | 4 |
| 11 | Interaction map + per-person triggers + pre-meeting brief | 7, 10 |

Step 4 (lifecycle closure) is the highest value per unit of risk — no vendor, no
audio, works immediately off names people already say — and runs in parallel with
Step 5 (voice identity, the part that genuinely needs real-audio tuning).

## Verification checklist — what must be proven, not assumed

- [ ] pyannote embedding dimensionality — **done**, 512, read from the real model
- [ ] Whether pyannote's raw embedding output is L2-normalized
- [ ] Diarization + identity accuracy measured on **Sinhala/Tamil/English
      code-switched** audio, not English-only — the actual workload, and the one most
      likely to behave differently from published benchmarks
- [ ] Whether Meet/Teams speaker-label timings share a clock with the audio file
      (the reason the roster session-level sanity gate exists at all)
- [ ] Same speaker re-identified correctly across two separate sessions
- [ ] Voiceprint isolation across orgs proven by test, not just scoped by convention
- [ ] The minimum-confidence threshold that separates useful ownership from invented
      accountability — deliberately unset until measured
- [ ] Per-person metrics verified to exclude low-confidence/coverage-gap items
- [ ] A blocked-but-not-failed commitment renders with its blocker, not as a bare miss
- [ ] A claimed-done-but-still-open work item surfaces as needs-reconciling, not
      silently resolved
