# VisualSprint Documentation

**Current phase: incremental implementation (2026-10-07).** Build one reviewed feature slice at a time.
[PROJECT_PLAN.md](PROJECT_PLAN.md) is the canonical index and defines precedence.

## Current specification — read first

| Document | Purpose |
|---|---|
| [18 — Founder architecture](18-founder-platform-architecture.md) | Product scope, architecture, research, cost and migration |
| [20 — Engineering design](20-engineering-design.md) | Code structure, module boundaries, patterns and review standards |
| [21 — Feature plan](21-feature-delivery-plan.md) | F00–F14 implementation slices, UI, dependencies and completion gates |
| [22 — Data/API contracts](22-data-and-api-contracts.md) | Tables, permissions, endpoints, idempotency and background jobs |
| [23 — Testing/operations](23-testing-and-operations.md) | Real-meeting tests, deployment, recovery, costs and release gates |
| [24 — Decisions/traceability](24-decisions-and-traceability.md) | Owner choices, rejected assumptions, risks and requirements mapping |
| [19 — Progress ledger](19-founder-platform-progress.md) | Actual local work, pause state and next implementation step |
| [26 — Project workspace delivery](26-project-workspace-delivery.md) | Project/customer meeting UI, verification and remaining worker gates |

## Legacy references

The documents below describe the earlier product or historical incidents. They remain useful
for understanding existing code, but current specifications above supersede conflicting claims.

| Doc | Contents |
|---|---|
| [01-vision-and-competitive.md](01-vision-and-competitive.md) | Problem, product thesis, locked decisions, competitor analysis, where we win |
| [02-architecture.md](02-architecture.md) | System spine, five agents, anti-hallucination rules, tech stack, scalability & swap points |
| [03-capture.md](03-capture.md) | Capture modes A1/A2/B/C/D, per-platform strategy, keyframes, coverage honesty |
| [04-asr.md](04-asr.md) | Buy-everything ASR strategy, Google⇄Azure pair, routing cascade, LLM repair, costs |
| [05-data-model.md](05-data-model.md) | All core tables, lifecycle vs edges, DB-enforced action gate |
| [06-roadmap.md](06-roadmap.md) | Phases 0–6, deliverables, first sellable slice |
| [07-verification-and-risks.md](07-verification-and-risks.md) | E2E test strategy, acceptance criteria, risk register |
| [16-bot-reliability.md](16-bot-reliability.md) | Production bot incident findings, durable capture fixes, and Meet setup |
