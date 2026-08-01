# Vision & Competitive Position

## The problem

A transcript alone cannot give the full context of a meeting — the real information lives in *speech + what was on screen at that moment + who said it + what earlier meetings established*. VisualSprint captures all four, fuses them with a multi-agent system, and turns meetings into **searchable, evidence-grounded organizational memory** for teams that mix **Sinhala, Tamil, and English** mid-sentence.

**Product loop:** Capture → Understand → Verify → Remember → Act

**Outcome test:** six months post-deployment, "why are we using MongoDB?" returns a traced answer across three meetings — speaker, transcript span, and the screen content visible at each decisive moment — correctly transcribed through code-switching, with any capture gap honestly disclosed.

## Locked decisions

| Decision | Choice |
|---|---|
| Purpose | Commercial MVP for real users; professional, scalable architecture |
| Languages | Sinhala + Tamil + English from day one |
| ASR | **Buy everything, train nothing** — Google `chirp_2` ⇄ Azure `si-LK`/`ta-IN` locked pair, Groq for English (see [04-asr.md](04-asr.md)) |
| Capture | Official platform APIs first; bots only fallback (see [03-capture.md](03-capture.md)) |
| Build-vs-buy | Buy 3rd-party now, own later — everything behind swap interfaces (see [02-architecture.md](02-architecture.md)) |

## Competitive landscape (verified 2026)

| Capability | Competitors | Us |
|---|---|---|
| Capture, auto-join, transcription, summaries | Commodity — all do it; platforms bundle free | Parity via official APIs |
| Workflow automation | **Fireflies is the bar**: 200+ AI Skills, 70+ connectors, field-level CRM sync; Fathom drafts follow-ups, posts to Slack | Match top automations, each grounded in **verified evidence** |
| Chat across meetings | Otter AI Chat: **English-only, disclaims correctness**. Fireflies: **"does not retain context across multiple meetings"** | ⭐ Evidence-grounded trilingual chat over lifecycle-aware memory |
| Speaker attribution | "Often inaccurate… muddied who said what" (Fireflies reviews) | ⭐ Exact on Zoom (per-participant audio); honest confidence elsewhere |
| Sinhala / si-ta-en code-switching | **Zero support anywhere** | ⭐ Own the category |
| Speech↔screen grounding | Nobody links utterances to on-screen content temporally | ⭐ Own the category |
| Capture-coverage honesty | Nobody reports gaps | ⭐ Own the category |

**Strategy:** parity fast on commodity; pour effort into the ⭐ rows — each is structural (requires our evidence model), not a feature toggle competitors can copy.

## Product surfaces

1. **Meeting report** — generated only from verified knowledge items; confidence badges, evidence links, coverage banner.
2. **Org-memory chat** — "Claude Code for your meetings": full org meeting history, every claim cites clickable evidence chips. Includes meeting-prep briefings.
3. **Automation layer** — human-gated proposals from verified knowledge: follow-up email drafts, Slack/Teams recaps, Jira/GitHub/Linear tasks, calendar follow-ups, blocker escalations, commitment reminders. Post-MVP: field-level CRM sync.
4. **Correction & glossary UI** — fixes improve the org glossary immediately and accrue (with consent) into the only si-ta-en code-switched meeting corpus in existence: product feature now, strategic moat forever.
