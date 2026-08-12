# Longitudinal Intelligence — the multi-agent analysis layer

The unique selling point, stated plainly: **anyone can summarise a meeting. We can tell
you that Nimal has raised the same blocker in four consecutive standups and nothing has
moved.** That claim requires reasoning *across* meetings about *a person*, which no part
of the current system does.

Companion to [09-participant-intelligence.md](09-participant-intelligence.md), which
built the data layer (identity, ownership, lifecycle). This document plans the
intelligence layer on top of it.

**Status: design only. Nothing here is implemented.**

## Where the intelligence gap actually is

Verified in the code, not assumed:

| Layer | State |
|---|---|
| Five agents (`context`, `verification`, `memory`, `action`, `report`) | All scoped to **one capture session**. None reason across meetings. |
| `app/agents/lifecycle.py` | Deterministic state derivation. Produces *state*, not *insight*. Correct, and deliberately not intelligent. |
| `app/api/people.py` | **Zero LLM involvement — pure SQL.** Returns `commitments`, `decisions_authored`, `coverage`. Lists, not analysis. |
| `KnowledgeItem.embedding` | Populated by `memory.py` — semantic comparison across meetings is already possible and unused for this. |

So the per-person surface today answers *"what did he commit to?"* It cannot answer
*"is he actually progressing, or repeating himself?"* — the question that makes this a
professional tool rather than a nicer transcript.

## What "full traction per participant" contains

The complete record this layer must produce for one person, so the goal is a
specification rather than an aspiration. Everything below is derivable from data the
system already stores — no new capture, no new vendor.

| Dimension | Question it answers | Source |
|---|---|---|
| **Per-meeting trace** | What did they say, decide, commit to, and raise in *this* meeting? | `KnowledgeItem` + `KnowledgeEvidence`, speaker-attributed |
| **Meeting-to-meeting delta** | What changed since last time — new, advanced, unchanged, dropped? | `KnowledgeEdge` traversal between consecutive sessions |
| **Commitment ledger** | Everything they ever committed to, and where each one stands | `owner_person_id` + `lifecycle_state` |
| **Delivery evidence** | Did it actually get done — claimed, or verified in Jira/GitHub/Linear? | Phase F work-tracker sync; three states, never collapsed |
| **Stagnation signal** | What have they raised repeatedly with nothing moving? | Repetition detection (below) |
| **Blocked vs idle** | Is the lack of movement theirs, or someone else's dependency? | `BLOCKS` edges |
| **Decision authorship** | What did they decide, and what superseded it since? | `SUPERSEDES` chains |
| **Contribution to others** | Whose blockers did they clear? | `RESOLVES` edges to others' items |
| **Interaction map** | Who do they work with, delegate to, unblock? | Structured edges + turn adjacency |
| **Trend** | Is follow-through rising or falling, over a comparable window? | Period comparison with a minimum-sample floor |
| **Coverage honesty** | How much of their speech was missed or low-confidence? | `CoverageInterval` + `attribution_confidence` |

Two properties make this "full" rather than merely long: **every row is clickable to its
evidence** (meeting, timestamp, quote, screen), and **every gap is stated** rather than
silently rendered as zero. A per-person record that quietly omits what it couldn't hear
is not a complete record — it is a misleading one.

## The architectural question: "multi-agent" without breaking rule 1

CLAUDE.md rule 1 is locked: **deterministic software owns the workflow; agents never
call each other, choose the next stage, or self-certify.** A "top-level intelligent
orchestrator agent" that decides what to analyse next would violate it directly.

That rule is not bureaucracy — it is what makes this auditable, reproducible, and
defensible when the output is *"this person repeatedly fails to deliver."* An LLM that
chose its own analysis path could not be re-run to the same answer, and an accountability
claim you cannot reproduce is a claim you cannot defend.

**So: multi-agent means many specialised agents, deterministically orchestrated — not
agents talking to each other.** Every proposal below keeps a plain FSM in control and
puts the intelligence inside individual, narrowly-scoped, evidence-bound agents. That is
also how you get *better* results: a narrow agent with a typed schema and a fixed
evidence set outperforms a general agent improvising a workflow.

## A second pipeline, person-scoped

The existing pipeline is **session-scoped** and event-driven (a meeting arrives).
Longitudinal analysis is **person-scoped** and cadence-driven (after new meetings land,
or on a schedule). It must be a separate FSM — reusing the meeting pipeline would mean
re-analysing a person's whole history every time one meeting is uploaded.

```
assemble → detect → assess → narrate → recommend
```

| Stage | Kind | Produces |
|---|---|---|
| `assemble` | **Deterministic** | The person's evidence corpus: items, lifecycle states, edges, meeting sequence, coverage disclosure. No LLM. |
| `detect` | Agent — *Pattern Analyst* | Typed pattern findings (repetition, stagnation, drift, contradiction) each bound to specific item IDs |
| `assess` | Agent — *Progress Assessor* | Period-over-period movement, with explicit "insufficient data" as a first-class answer |
| `narrate` | Agent — *Participant Narrator* | The professional written summary |
| `recommend` | Agent — *Coaching Agent* | Concrete suggested actions, routed through the existing `ProposedAction` approval gate |

Idempotent and incremental like every existing stage: keyed on
`(person_id, analysis_period)`, re-runnable, and skipped entirely when no new evidence
has landed since the last run — otherwise this becomes the most expensive thing in the
product.

**`narrate` never receives raw transcript** — same constraint as Report Intelligence
(rule 2), for the same reason: a narrative about a person's performance is precisely
where a hallucinated quote would do the most damage.

## Hard problem 1 — repetition vs. legitimate progress

This is the feature's core claim and its biggest failure risk. *"He says the same thing
every meeting"* is only meaningful if we can distinguish it from an honest status update.

Consider three sequences that look similar to a naive matcher:

| Sequence | Truth |
|---|---|
| "Gateway needs fixing" → "Gateway needs fixing" → "Gateway needs fixing" | **Stagnation.** The real signal. |
| "Started the gateway work" → "Gateway 60% done" → "Gateway in review" | **Progress.** Flagging this would be wrong and insulting. |
| "Gateway blocked on vendor key" ×4 | **Blocked, not idle.** Escalation, not a performance problem. |

Detection therefore requires **multiple independent signals**, not one:

1. **Semantic similarity** across meetings via existing `KnowledgeItem.embedding` —
   deterministic, cheap, no LLM.
2. **Lifecycle non-advancement** — the chain never reaches `RESOLVED`
   (`app/agents/lifecycle.py` already derives this).
3. **Absence of a linked `BLOCKS`** — distinguishes stalled from blocked.
4. **No work-tracker movement** — Phase F's ticket status, when connected.
5. **Agent judgement, last** — the *Pattern Analyst* sees the candidate sequence plus
   its evidence and rules on whether it represents progress. It never searches; the
   deterministic layer hands it the candidates.

**Rule: no repetition finding is emitted on LLM judgement alone.** The agent can only
*downgrade* a deterministically-detected candidate, never invent one. This keeps the
most reputationally dangerous output in the product anchored to reproducible signals.

## Hard problem 2 — identity: many names, and shared accounts

> **Deferred by decision (2026-08-11).** Descoped for now to keep focus on
> per-participant decision tracking and agent accuracy
> ([11-agent-architecture.md](11-agent-architecture.md)). The design below is kept
> because the shared-account case is a genuine correctness risk, not a nicety: an
> account used by two people will merge two people's accountability into one record,
> and no downstream metric can detect that after the fact. Revisit before onboarding
> any org that uses shared conference-room accounts.

Currently identity rests on `Person.display_name`, `email`, `aliases` (a JSON list),
`user_id`, and `voiceprint`. That handles the easy direction and fails the dangerous one.

**Direction A — one person, many identifiers.** "Nimal", "Nimal Perera", "nimal.p",
"නිமල්", a work email and a personal one, two platform accounts. Merging these is
*desirable* — otherwise their history fragments and every metric under-counts them.

**Direction B — one identifier, many people.** A shared conference-room Zoom account. A
laptop two people use. A generic `standup@company.com`. Here merging is a **serious
error**: it fuses two people's accountability into one record, and no downstream metric
can recover from it.

Direction B is the one current design would get wrong, because an account ID looks like
strong evidence and isn't.

**Proposed: identity claims, not identity fields.**

```
PersonIdentityClaim(person_id, claim_type, value, source, confidence, first_seen, last_seen)
   claim_type ∈ {email, platform_account, display_name, user_login, voiceprint}
   source     ∈ {roster, oauth_verified, voice_match, manual, inferred}
```

Identity becomes an accumulating, auditable body of evidence rather than columns that
silently overwrite. Then:

- **Merge requires two independent claim types** — e.g. a verified email *and* a voice
  match. A name alone never merges anyone.
- **Shared-account detection:** when one `platform_account` claim consistently maps to
  **multiple distinct voiceprints**, mark it `shared` and stop treating it as identity
  evidence entirely. This is the specific guard for Direction B, and it falls out of
  data we already collect.
- **Merges are reversible.** `PersonMerge(from_person_id, into_person_id, reason,
  performed_by, at)` with the claims preserved, so a wrong merge is undone rather than
  archaeologically reconstructed.
- **Above a confidence threshold, propose — don't merge.** Surface "these two look like
  the same person" for one click. In an accountability product, a silent wrong merge is
  worse than an unmerged duplicate.
- **Never merge across orgs.** Same rule as voiceprints.

Alias matching itself needs the tri-lingual handling already specified in
[09](09-participant-intelligence.md): NFKC + casefold, honorific/kinship stripping,
cross-script aliases, and **ambiguity resolving to nobody**.

## Improvement measurement — honest by construction

*"Minor improvement"* is exactly where a tool loses credibility by over-claiming on thin
data. Constraints, not disclaimers:

- **Minimum sample.** Below a floor (e.g. 5 comparable commitments across ≥3 meetings),
  the answer is **"not enough data"** — a first-class result, never a number.
- **Compare like with like.** Period-over-period within the same recurring series
  (`Meeting.external_calendar_event_id`), not across different meeting types.
- **Disclose the denominator.** "3 of 4 delivered" always beats "75%".
- **Report movement, not grades.** *"Follow-through rose from 2/5 to 4/5; two blockers
  that recurred last month are now closed."* No letter grades, no leaderboard.
- **Confounders stated.** If coverage was poor or attribution confidence low for that
  person in a period, the assessment says so rather than quietly scoring them down —
  the tri-lingual fairness constraint from [09](09-participant-intelligence.md) applied
  to trends.

Signals worth trending: follow-through rate, time-to-resolution, blocker recurrence
(falling is good), commitment specificity (do they carry due dates?), and unblocking
others.

## Upgrading the multi-agent system overall

Concrete, grounded improvements — not architecture for its own sake:

1. **Model routing by task shape.** Partially done (`flash-lite` for classify/repair,
   `pro` for extract/verify/report). Extend deliberately: pattern detection over a long
   history is a reasoning task; narration is a writing task; they need not be the same
   model. Longitudinal analysis is the first thing in this product that could get
   genuinely expensive, so routing is a cost control, not a nicety.

2. **Extend the critic pattern.** `verification` already re-checks claims against raw
   evidence without seeing the extractor's reasoning — the strongest idea in the current
   design. Longitudinal findings deserve the same treatment: a claim about a *person*
   warrants at least the scrutiny of a claim about a meeting.

3. **Calibration harness.** `app/evaluation/` already measures ASR. Nothing measures
   whether `VERIFIED` actually correlates with correct, or whether a repetition finding
   holds up to human review. Without this, confidence labels are decoration. This is the
   single highest-leverage addition to agent quality.

4. **Incremental analysis.** Cache per-person analysis keyed on the evidence set's
   content hash; unchanged history is never re-analysed.

5. **Deterministic-first ordering everywhere.** Embeddings, lifecycle states, and edge
   traversal are cheap, reproducible, and already built. Every agent should receive a
   *shortlist* the deterministic layer produced, never an open-ended corpus.

6. **Graceful degradation.** Follow the existing precedent (VLM captioner, embedder,
   diarizer): if the analysis layer is unavailable, per-person data still renders. The
   product must never fail because the smart part is down.

## Visual surface — the graphs

The frontend currently has **no charting library** (verified: `package.json` carries only
Next/React/Supabase) and one hand-rolled stacked bar built from flex divs in the report
page. That constraint shapes what to build.

| Graph | Shows | How |
|---|---|---|
| **Commitment timeline** | Each commitment as a bar from the meeting it was stated to the meeting it resolved — unresolved ones run to "today" and visibly don't end | Positioned divs on a shared time axis |
| **Follow-through trend** | Delivery rate across a recurring series | Inline SVG polyline sparkline |
| **Recurrence heat strip** | Topic × meeting grid; a row of filled cells that never closes *is* the stagnation signal, seen at a glance | Grid of divs |
| **Decision evolution** | A `SUPERSEDES` chain as a vertical timeline: original → what changed → current, each hop with its rationale | Bordered divs (existing idiom) |
| **Commitment funnel** | Stated → in progress → delivered / lapsed | Stacked bar, same technique as the existing engagement bar |
| **Interaction map** | Who unblocks, delegates to, and builds on whom | Inline SVG, deterministic radial layout |
| **Status distribution** | Open / overdue / delivered / blocked mix per person | Stacked bar |

**Charting-library decision.** Everything except the interaction map is a bar, a grid, or
a polyline — all cheaper to hand-roll in the existing inline-style idiom than to justify a
dependency, and they inherit theme tokens for free. The interaction map is the only real
candidate for a library, and even it works as hand-written SVG with a **deterministic
radial layout** (people placed by a stable sort, not a physics simulation) — which is
also *more* correct here: a force-directed graph that settles differently on each render
would violate the reproducibility this product sells. Revisit only if a genuinely
force-directed or zoomable view is needed.

**Every graph is clickable through to evidence.** A bar segment opens the commitment; a
heat cell opens that meeting's moment; a chain hop opens the transcript span and screen
that justify it. A chart that can't be interrogated is decoration, and in an
accountability tool, decoration that looks like evidence is worse than no chart.

**Graphs must render their own gaps.** A period with poor coverage is drawn as a hatched
or greyed span, not as a zero — otherwise the picture silently lies in exactly the
direction that penalises the speakers whose audio we captured worst.

## Automation this unlocks

Each follows from the same data; none needs a new vendor:

- **Pre-meeting brief** — "Last time: 3 commitments, 1 delivered. This blocker has
  recurred 4×." Delivered before the meeting, where it can change the outcome.
- **Agenda proposal** — unresolved recurring items ranked by staleness.
- **Stale-commitment nudge** — per-person, via the existing approval-gated connectors.
- **Blocker escalation** — deterministic trigger already exists; add recurrence depth.
- **Weekly team digest** — what moved, what stuck, what needs a decision.
- **New-joiner brief** — the decision chain behind current architecture, with evidence.
- **Meeting effectiveness** — did this meeting produce decisions, or only discussion?
- **Commitment-quality coaching** — "your commitments rarely carry dates" is actionable
  and impersonal.

All route through `ProposedAction` + approval. Nothing auto-sends.

## Professional-tool requirements

What separates this from a demo:

- **Every claim carries its evidence** — meeting, timestamp, speaker, quote. A finding
  you cannot click into is a finding nobody will trust.
- **Confidence and sample size always visible.**
- **Reproducible** — same inputs, same findings. Enabled by deterministic candidate
  selection.
- **Auditable** — `AuditLog` for every derived state and every identity merge.
- **Exportable** — per-person and per-team, PDF/CSV.
- **Correctable** — every derived conclusion can be disputed, and disputes feed
  calibration.
- **Framed as team improvement, not surveillance** — the framing constraint from
  [09](09-participant-intelligence.md), which is also the more sellable position.

## Build order

| Step | Work | Depends |
|---|---|---|
| 1 | `PersonIdentityClaim` + `PersonMerge` schema; claim recording at identity resolution | — |
| 2 | Shared-account detection (one account → multiple voiceprints) | 1 |
| 3 | Merge proposal + reversible merge, human-confirmed | 1,2 |
| 4 | Deterministic repetition detection (embeddings + lifecycle + blockers) | — |
| 5 | Longitudinal FSM + `assemble` stage | 4 |
| 6 | Pattern Analyst agent (downgrade-only over deterministic candidates) | 5 |
| 7 | Progress Assessor with minimum-sample floor | 5 |
| 8 | Participant Narrator (no raw transcript) | 6,7 |
| 9 | Coaching agent → `ProposedAction` | 8 |
| 10 | Calibration harness | 6,7 |
| 11 | Graphs — timeline, trend, heat strip, funnel, interaction map, all evidence-clickable | 5,6,7 |
| 12 | Pre-meeting brief, digest, agenda proposal | 8 |

Steps 1–4 are deterministic and independently valuable — shared-account detection and
repetition detection improve the product before any new agent exists.

## Risks

1. **Wrongly calling progress "repetition."** Insulting, and destroys trust instantly.
   *Mitigated: multi-signal detection; the agent may only downgrade candidates.*
2. **Merging two people who share an account.** Silently fuses accountability.
   *Mitigated: shared-account detection; merges need two independent claim types.*
3. **Over-claiming improvement on thin data.** *Mitigated: minimum-sample floor with
   "insufficient data" as a real answer.*
4. **Cost.** Longitudinal analysis over long histories is the first genuinely expensive
   thing here. *Mitigated: incremental caching, deterministic shortlisting, model
   routing.*
5. **Surveillance perception.** A tool that feels like monitoring gets rejected by the
   team it's meant to help. *Mitigated: framing, no scores, no rankings, disputable
   findings.*
6. **Uncalibrated confidence.** Labels that don't correlate with correctness are worse
   than none. *Mitigated: the calibration harness — which is why it's a build step, not
   a footnote.*
