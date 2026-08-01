# Architecture

## Non-negotiable spine

**Deterministic software owns the workflow and decides what is true. Agents interpret content; they never call each other, never control orchestration, never self-certify.**

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

## Five agents, one orchestrator

| Agent | Role | Model tier |
|---|---|---|
| Context Intelligence | Extract candidate decisions/commitments/blockers/questions from speech + screen + roster | Sonnet |
| Evidence Verification | Challenge candidates **blind** — sees claim + raw evidence only, never extractor reasoning; assigns `verified / partially_supported / ambiguous / unsupported` | Sonnet |
| Memory Intelligence | Link against history, assign lifecycle state, propose edges | Opus |
| Action Intelligence | Propose automations from verified items | Haiku/Sonnet |
| Report Intelligence | Render report **from verified items only** | Sonnet |

**Two rules enforced by types, not prompts:**
1. Report Intelligence's input schema **cannot contain raw transcript** — hallucination cannot reach the user-facing report.
2. Verification never sees Context's justification — self-consistency is not verification.

## Technology

| Layer | Choice | Why |
|---|---|---|
| Backend | Python 3.12+, FastAPI | one language across pipeline + API |
| Orchestration | Postgres FSM, `FOR UPDATE SKIP LOCKED` workers | durable, inspectable, zero extra infra; upgrade path → Temporal |
| Data | PostgreSQL 16 + pgvector + FTS | relational + vector + graph edges in one store |
| Blobs | S3-compatible (Cloudflare R2) | zero egress fees |
| Agents | Claude API — Sonnet / Haiku / Opus tiered | cost control by task difficulty |
| Frontend | Next.js + TypeScript | report, chat, corrections, approvals |
| Deploy | Docker Compose (pilot) → K8s (scale) | same images both stages |

## Built to scale, built to swap

- **Stateless services** — all state in Postgres/R2; every tier scales by adding replicas.
- **Queue-decoupled stages** — idempotent jobs, safe retries, natural backpressure.
- **Multi-tenant day one** — `org_id` on every row; per-org encryption keys for audio at rest.

### Swap points (buy now → own later)

| Interface (`backend/app/interfaces/`) | Bought today | Owned later |
|---|---|---|
| `Transcriber` | Google/Azure/Groq cascade | fine-tuned CS model |
| `Diarizer` | pyannote | custom fusion |
| `OcrEngine` | PaddleOCR | — |
| `LlmClient` | Claude API | provider-agnostic already |
| `PlatformAdapter` | official platform APIs | bot fleet (Vexa/Attendee fork) |
| `ActionConnector` | per-tool REST | unified connector framework |

Swapping any implementation touches **zero** downstream code.
