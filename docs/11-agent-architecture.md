# Agent Architecture — the complete roster and how it gets accurate

Per-participant decision tracking is the product's core claim. It is also the highest-risk
output we produce: telling someone their decisions get reversed, or that they raise the
same blocker without progress, must be **right**, **reproducible**, and **traceable** —
or it is worse than saying nothing.

This document plans the full agent roster and, more importantly, the accuracy engineering
that makes those agents trustworthy. Companion to
[09-participant-intelligence.md](09-participant-intelligence.md) (data layer) and
[10-longitudinal-intelligence.md](10-longitudinal-intelligence.md) (analysis layer).

**Status update 2026-08-12:** temperature control, explicit abstention, prompt
versioning, the offline per-language/per-agent evaluation harness, deterministic
grounding, high-stakes ensemble agreement, agents 6–10, and the transcript-free
narrator schema are implemented locally. The checked-in frozen baseline is synthetic
and deliberately cannot substantiate an accuracy claim; consented real Sinhala,
Tamil, English, and code-switched meetings plus human labels are still required for
calibration and measured model-tier routing.

## Two accuracy defects in the current system

Both verified in code, and both undercut claims the product already makes:

### 1. Sampling is uncontrolled

`app/adapters/llm_gemini_vertex.py` builds `GenerateContentConfig` with
`system_instruction`, `response_mime_type`, `response_schema`, `max_output_tokens` — and
**no temperature**. The `LlmClient` Protocol has no temperature parameter, so it cannot
be set per call. Every extraction, verification, and memory call therefore runs at the
model's default sampling temperature (~1.0 for Gemini 2.5).

Consequences that matter:

- **The same meeting, processed twice, can yield different knowledge items.** A product
  whose selling point is auditable evidence cannot have a non-reproducible extraction step.
- Higher sampling temperature raises fabrication rate on exactly the tasks that must not
  fabricate — which items exist, which utterance supports them, who owns them.
- Re-running a stage after a crash (the pipeline is explicitly designed to be
  re-runnable) may silently produce a *different* answer than the first attempt.

Extraction, classification, and verification are **not creative tasks**. They should run
at temperature 0.

### 2. Agent accuracy is never measured

`app/evaluation/` contains exactly one module: `asr_eval.py`. ASR quality has a real
harness (WER, code-switch WER, switch-point F1, frozen-report regression gate). **Agent
output has nothing.** There is no golden set, no precision/recall, no attribution
accuracy, no regression gate.

So today: no one can say whether a prompt change made extraction better or worse, and
`Confidence.VERIFIED` is an assertion with no evidence that it correlates with being
correct. Every accuracy improvement below is unmeasurable until this exists — which is
why it is the first build step, not the last.

## The complete agent roster

Nine agents. Five exist; four are new. Every one is **deterministically invoked** — no
agent calls another, none chooses the next stage (CLAUDE.md rule 1). "Multi-agent" here
means many narrow specialists, which is also what makes them accurate: a tightly-scoped
agent with a typed schema and a fixed evidence set beats a general agent improvising.

### Session-scoped (exist today)

| # | Agent | Job | Model tier |
|---|---|---|---|
| 1 | **Context Intelligence** | Extract candidate knowledge items from utterances + keyframes | reasoning |
| 2 | **Evidence Verification** | Re-check each claim against raw evidence, blind to the extractor's reasoning | reasoning |
| 3 | **Memory Intelligence** | Propose cross-session edges; write embeddings | reasoning |
| 4 | **Action Intelligence** | Draft an actionable task from an item | cheap |
| 5 | **Report Intelligence** | Write the meeting report from a transcript-free input | reasoning |

### Person-scoped (new)

| # | Agent | Job | Why it's separate |
|---|---|---|---|
| 6 | **Decision Trajectory Analyst** | For each decision a person made: did it hold, get revised, get contradicted — and was a revision *principled* (new information) or *churn* (no new information)? | Memory Intelligence links items pairwise; nothing reasons about a person's decision record as a whole |
| 7 | **Pattern Analyst** | Judge deterministically-detected repetition candidates: genuine stagnation, or legitimate progress? | The single highest-risk judgement in the product; needs its own narrow scope and its own eval |
| 8 | **Progress Assessor** | Period-over-period movement, with "insufficient data" as a real answer | Trend reasoning is a different task from pattern detection and must not be conflated |
| 9 | **Participant Narrator** | Write the professional per-person summary | Writing task, different model tier; receives **no raw transcript** (rule 2) |

Plus one critic, reusing the system's best existing idea:

| # | Agent | Job |
|---|---|---|
| 10 | **Claim Auditor** | Independently verify longitudinal claims (6/7/8) against their evidence, **blind to the analyst's reasoning** — Evidence Verification's pattern applied to cross-meeting claims about people |

The Coaching Agent from [10](10-longitudinal-intelligence.md) is deliberately *not* an
agent here: its output is a `ProposedAction`, and the existing Action Intelligence already
does that job. Fewer agents, each doing more work correctly.

## Accuracy engineering

This is the substance. Ordered by leverage.

### A. Golden set + regression gate (build first)

Nothing else can be validated without it. Mirror `asr_eval.py`'s structure in
`app/evaluation/agent_eval.py`:

- **Frozen corpus** of real meetings with human-labelled ground truth: which items exist,
  their types, their owners, their supporting utterances.
- **Must include Sinhala/Tamil/code-switched meetings**, not just English. This is the
  actual workload, and the case most likely to diverge from published model benchmarks.
- **Metrics per agent:**
  - Extraction: precision / recall / F1 on items, per `KnowledgeType`
  - Ownership: attribution accuracy, and **false-attribution rate** tracked separately —
    wrongly assigning a commitment is far more costly than missing one
  - Verification: agreement with human labels; calibration of `Confidence`
  - Pattern Analyst: **false-repetition rate** — calling progress "stagnation" is the
    reputational failure mode, so it gets its own number
  - Abstention rate (see C) — reported, never penalised
- **Contrast pairs**, not just positive examples: "I'll fix it" vs "someone should fix
  it"; a verbatim repeat vs a genuine status update; a principled revision vs churn.
  Near-misses are where accuracy is actually won.
- **CI gate**, same as the ASR frozen-report gate: a prompt or model change that regresses
  any metric fails.

### B. Sampling discipline

Add `temperature` to the `LlmClient` Protocol and thread it through all three adapters.

| Task | Temperature | Why |
|---|---|---|
| Extraction, verification, classification, edge proposal, pattern judgement | **0** | Reproducibility is a product requirement; these have one right answer |
| Narration | 0.2–0.3 | Fluency matters; the facts come from structured input, so drift risk is bounded |

Document at the interface that temperature 0 is the default and any nonzero value needs a
stated reason — otherwise it silently creeps back.

### C. Abstention as a first-class output

Every agent schema gets an explicit "insufficient evidence" branch, and prompts state
that abstaining is **correct** behaviour, not failure. Then measure abstention rate and
leave it uncapped: in an accountability product, a system that declines when uncertain is
more valuable than one that always answers.

Concretely: no owner rather than a guessed owner; no pattern finding rather than a weak
one; "not enough data" rather than a trend from three points.

### D. Deterministic candidate selection (extend existing practice)

Agents **judge**, they never **search**. The deterministic layer selects candidates
(embeddings, lifecycle states, edge traversal, SQL) and hands over a shortlist; the agent
rules on it.

Already the pattern in `memory.py` (`_find_related` shortlists, agent picks edges) and it
should be universal. For the Pattern Analyst the rule is stricter still: **the agent may
only downgrade a deterministically-detected candidate, never invent one.** No claim about
a person originates in an LLM's free judgement.

### E. Independent verification of person-level claims

Evidence Verification's key property is that the critic **never sees the extractor's
reasoning** — only the claim plus raw evidence. Self-consistency is not verification.

Apply exactly that to the Claim Auditor: it receives a longitudinal finding and the
underlying items/edges/states, never the analyst's rationale, and independently rules
supported / partially supported / unsupported. Unsupported findings never reach a user.

### F. Ensemble on high-stakes claims only

For claims *about a person* (agents 6–8), sample N times at temperature 0 with
deliberately varied evidence ordering; require agreement to emit. Disagreement → abstain.

Reserved for person-level claims specifically, because it multiplies cost and these are
the only outputs where being wrong damages someone's standing.

### G. Deterministic grounding checks (post-hoc, cheap)

Machine-checkable invariants, run after every agent call — no LLM, no cost:

- Every cited utterance/keyframe ID exists in the session (already done in `context.py`)
- Every cited item ID exists and belongs to the same org
- A claimed owner matches the cited utterance's `person_id` when `owner_source=SPEAKER`
- Every rendered quote comes from the database, never from model output (already correct —
  `app/api/report.py` reads quotes from `Utterance`)
- Any date is within the meeting's plausible range

A violated invariant drops the claim and logs it as an eval signal. These catch the
failures prompting cannot.

### H. Calibration

Compare stated confidence against golden-set correctness; plot the reliability curve. If
`VERIFIED` is right 70% of the time, either the label or the threshold is wrong. Recheck
whenever the model or prompt changes — an uncalibrated confidence label is worse than no
label, because the UI presents it as trustworthy.

### I. Prompt versioning

Prompts are behaviour. Version them, record which version produced each result, and tie
every eval run to a version so a regression is attributable. Cheap to add now, impossible
to retrofit onto historical data.

### J. Model routing with measured justification

Current routing (`pro` for reasoning, `flash-lite` for classify/repair) is sensible but
unmeasured. Once the golden set exists, routing becomes an evidence-based decision:
run each agent against each tier and pick the cheapest that holds accuracy. Longitudinal
analysis over long histories is the first genuinely expensive thing in this product, so
this pays for itself.

## Per-participant decision tracking — the flow

```
DETERMINISTIC                                    AGENT
─────────────────────────────────────────────────────────────────────
assemble  ──►  person's decisions + edges
               + lifecycle states
               + edge rationales                 ──►  (6) Decision Trajectory
                                                       held / revised / churn
detect    ──►  repetition candidates
               (embedding similarity +
                lifecycle non-advance +
                no BLOCKS + no ticket move)      ──►  (7) Pattern Analyst
                                                       downgrade-only
assess    ──►  period buckets, sample counts     ──►  (8) Progress Assessor
                                                       or "insufficient data"
              ┌──────────────────────────────────────────────┐
              │  (10) Claim Auditor — blind to reasoning      │
              │       drops unsupported findings              │
              └──────────────────────────────────────────────┘
narrate   ──►  audited findings only             ──►  (9) Participant Narrator
                                                       no raw transcript
```

Every arrow into an agent carries a **deterministically built, evidence-bound payload**.
Every arrow out is **schema-validated, invariant-checked, and audited** before a human
sees it.

### On decision-quality fairness

Agent 6 judges whether a revision was principled or churn. That distinction must lean on
`KnowledgeEdge.rationale` — actual stated reasons — not on revision count. **Changing a
decision when new information arrives is good judgement, not instability**, and a tool
that penalises it teaches people to defend bad decisions. Only revision *without* new
information is a signal, and where the rationale is thin the honest output is abstention.

## Build order

| Step | Work | Depends |
|---|---|---|
| 1 | `app/evaluation/agent_eval.py` + labelled golden set (incl. si/ta/code-switched) | — |
| 2 | `temperature` on `LlmClient` + all adapters; set 0 for extract/verify/memory/classify | — |
| 3 | Baseline every existing agent against the golden set | 1,2 |
| 4 | Deterministic grounding-invariant checks after every agent call | — |
| 5 | Abstention branches in all agent schemas + rate reporting | 1 |
| 6 | Prompt versioning + CI regression gate | 1 |
| 7 | Decision Trajectory Analyst | 1–4 |
| 8 | Pattern Analyst (downgrade-only) | 1–4, deterministic detection from [10](10-longitudinal-intelligence.md) |
| 9 | Progress Assessor with minimum-sample floor | 1–4 |
| 10 | Claim Auditor (blind critic for 7/8/9) | 7,8,9 |
| 11 | Participant Narrator | 10 |
| 12 | Ensemble for person-level claims | 10 |
| 13 | Calibration curves + threshold tuning | 3,10 |
| 14 | Model-routing decisions from measured accuracy | 3,13 |

Steps 1–2 are small, and everything downstream is guesswork without them. Step 2 alone
(temperature 0) is a few lines and immediately makes the existing pipeline reproducible.

## Risks

1. **Shipping accuracy work that cannot be measured.** Every technique here is
   unfalsifiable without step 1. *Mitigation: golden set first, and no accuracy claim in
   the product until it exists.*
2. **A confidently wrong claim about a person.** The worst output available to us.
   *Mitigation: downgrade-only pattern detection, blind auditor, ensemble agreement,
   abstention, deterministic invariants.*
3. **Non-reproducible extraction** undermining the auditability the product sells.
   *Mitigation: temperature 0, prompt versioning.*
4. **Tri-lingual accuracy assumed from English benchmarks.** *Mitigation: si/ta/
   code-switched cases are mandatory in the golden set, and reported separately — an
   aggregate number would hide exactly the weakness that matters here.*
5. **Cost growth** from ensembles and longitudinal re-analysis. *Mitigation: ensemble
   restricted to person-level claims; incremental caching; measured model routing.*
6. **Over-engineering.** Ten agents is a real maintenance surface. *Mitigation: each new
   agent must earn its place with a distinct schema, a distinct failure mode, and its own
   eval metric — otherwise it belongs inside an existing one.*
