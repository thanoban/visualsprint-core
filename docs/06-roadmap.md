# Roadmap

Solo-dev week estimates.

| Phase | Weeks | Deliverable |
|---|---|---|
| **0. Foundations** ✅ | 1–2 | Monorepo, schema, FSM orchestrator, blob store, all six swap-point interfaces |
| **0b. ASR baseline** | 1–3 | Gold set + eval harness; rank Google vs Azure; freeze regression baseline |
| **1. Capture** | 3–6 | **Mode D upload first** ✅ (walking skeleton) → Mode A2 artifacts (Meet REST, Zoom Cloud Rec) → A1 RTMS. Calendar watch, disclosure, coverage telemetry |
| **2. ASR cascade** | 4–7 | VAD + LID + routing + failover + LLM repair; correction UI + glossary (flywheel live) |
| **3. Understanding** | 7–12 | Keyframes, OCR/VLM, speech↔screen grounding, five agents, evidence + confidence |
| **4. Memory + Chat** | 11–15 | Lifecycle edges, hybrid retrieval, **org-memory chat with evidence chips** — MongoDB acceptance test passes |
| **5. Product + Automation** | 14–18 | Report UI, coverage display, approval UI; follow-up email, Slack recap, Jira/GitHub task automations |
| **6. Expansion** | 18+ | Teams Graph adapter, bot fallback (fork Vexa/Attendee), CRM field-sync, pilot onboarding |

**First sellable slice — end of Phase 4 (~4 months):** Zoom + Meet capture, tri-lingual transcription, evidence-graded knowledge, cross-meeting memory, chat. Phase 5 reaches automation parity with Fireflies/Fathom.

## Parallel workstream: consent & compliance

Sri Lanka PDPA (No. 9 of 2022) + platform ToS + recording-consent law. Disclosure, join policy, retention windows, export/deletion built in from Phase 0 — not retrofitted. **Requires local legal review before pilot** — this plan flags requirements; it does not assert what the law permits.
