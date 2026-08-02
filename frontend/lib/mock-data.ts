// ---------------------------------------------------------------------------
// MOCK DATA BOUNDARY
//
// Everything in this file is a temporary stand-in. Both real endpoints exist
// now (backend/app/api/report.py, backend/app/api/chat.py) -- this file is
// just not wired to them yet:
//   - GET /api/v1/meetings/{id}/report   (report page)
//   - POST /api/v1/chat                  (chat page, on fetch failure)
//
// TODO: wire report page to the real endpoint instead of this fixture.
// TODO: wire chat page to the real endpoint instead of this fixture.
//
// This is the ONLY file in the app that should contain fixture data. When the
// real endpoints land, delete the mock* functions below and replace their
// call sites (app/meetings/[id]/report/page.tsx, app/chat/page.tsx) with
// real `fetch` calls against lib/config.ts's API_BASE_URL. No other file
// should need to change.
// ---------------------------------------------------------------------------

import type { ChatMessage, MeetingReport } from "./types";

/** TODO: replace with real API once report endpoint exists. */
export async function getMockMeetingReport(meetingId: string): Promise<MeetingReport> {
  // Simulate network latency so loading states are visibly exercised.
  await new Promise((resolve) => setTimeout(resolve, 350));

  return {
    meeting_id: meetingId,
    title: "Infra Sync — Database Migration Planning",
    occurred_at: "2026-07-28T09:00:00+05:30",
    coverage_gaps: [
      {
        id: "gap-1",
        modality: "screen",
        status: "missing",
        reason: "Presenter's screen-share dropped for ~90s during the cost comparison walkthrough.",
        start_s: 612,
        end_s: 701,
      },
    ],
    engagement: {
      total_talk_time_s: 1840,
      participants: [
        { person_id: "p-1", display_name: "Nimal Perera", talk_time_s: 780, utterance_count: 42, talk_time_pct: 42.4 },
        { person_id: "p-2", display_name: "Kavindi Silva", talk_time_s: 610, utterance_count: 35, talk_time_pct: 33.2 },
        { person_id: "p-3", display_name: "Ruwan Fernando", talk_time_s: 340, utterance_count: 21, talk_time_pct: 18.5 },
        { person_id: null, display_name: "Unknown speaker", talk_time_s: 110, utterance_count: 6, talk_time_pct: 5.9 },
      ],
    },
    decisions: [
      {
        id: "ki-1",
        type: "decision",
        statement: "Migrate the primary datastore from MongoDB to Postgres with pgvector for knowledge retrieval.",
        owner: "Nimal Perera",
        confidence: "verified",
        lifecycle_state: "NEW",
        coverage_gap: false,
        rationale: "Directly stated and confirmed by two independent speakers with matching screen evidence.",
        evidence: [
          {
            id: "ev-1",
            speaker: "Nimal Perera",
            timestamp_s: 245,
            quote: "So we're going with Postgres and pgvector instead of standing up a separate vector DB or Neo4j.",
            keyframe_thumbnail_url: "https://placehold.co/160x90/1e293b/e2e8f0?text=Architecture+Slide",
            keyframe_caption: "Slide titled 'Datastore decision' showing Postgres + pgvector chosen over MongoDB/Neo4j.",
          },
          {
            id: "ev-2",
            speaker: "Kavindi Silva",
            timestamp_s: 268,
            quote: "Agreed, one less system to operate at our scale.",
          },
        ],
      },
    ],
    commitments: [
      {
        id: "ki-2",
        type: "commitment",
        statement: "Write the Alembic migration for the new knowledge_item schema.",
        owner: "Kavindi Silva",
        due: "2026-08-05",
        confidence: "verified",
        lifecycle_state: "NEW",
        coverage_gap: false,
        evidence: [
          {
            id: "ev-3",
            speaker: "Kavindi Silva",
            timestamp_s: 892,
            quote: "I'll have the migration ready by Wednesday.",
          },
        ],
      },
      {
        id: "ki-3",
        type: "commitment",
        statement: "Benchmark chirp_2 vs Azure si-LK on the last three field recordings before Friday.",
        owner: "Ruwan Fernando",
        due: "2026-08-07",
        confidence: "partially_supported",
        lifecycle_state: "NEW",
        coverage_gap: false,
        rationale: "Owner confirmed verbally but no explicit due date was repeated back; due date inferred from thread context.",
        evidence: [
          {
            id: "ev-4",
            speaker: "Ruwan Fernando",
            timestamp_s: 1042,
            quote: "I can take the ASR benchmarking, should have numbers this week.",
          },
        ],
      },
    ],
    requirements: [
      {
        id: "ki-4",
        type: "requirement",
        statement: "Report page must render screenshot evidence inline, not as a link.",
        owner: "Product",
        confidence: "verified",
        lifecycle_state: "NEW",
        coverage_gap: false,
        evidence: [
          {
            id: "ev-5",
            speaker: "Nimal Perera",
            timestamp_s: 130,
            quote: "This is the speech-to-screen grounding feature — it has to actually show the screenshot, not just a link.",
            keyframe_thumbnail_url: "https://placehold.co/160x90/1e293b/e2e8f0?text=Report+Mockup",
          },
        ],
      },
    ],
    blockers: [
      {
        id: "ki-5",
        type: "blocker",
        statement: "Zoom RTMS access request is stuck in IT approval, blocking Mode A1 capture testing.",
        owner: "Ruwan Fernando",
        confidence: "ambiguous",
        lifecycle_state: "RECURRING",
        coverage_gap: true,
        rationale: "Mentioned again this meeting (recurring); the screen evidence for the ticket status fell in the capture gap window.",
        evidence: [
          {
            id: "ev-6",
            speaker: "Ruwan Fernando",
            timestamp_s: 655,
            quote: "Still waiting on IT for the RTMS scopes, third week now.",
          },
        ],
      },
    ],
    questions: [
      {
        id: "ki-6",
        type: "question",
        statement: "Should the coverage-gap banner block report generation entirely, or just annotate affected items?",
        confidence: "unsupported",
        lifecycle_state: "NEW",
        coverage_gap: false,
        rationale: "Raised but no resolution was reached in this meeting; needs follow-up.",
        evidence: [
          {
            id: "ev-7",
            speaker: "Kavindi Silva",
            timestamp_s: 1180,
            quote: "Do we block the report or just flag it? We didn't actually decide.",
          },
        ],
      },
    ],
  };
}

/** TODO: replace with real API once chat endpoint exists. */
export function mockAssistantReply(question: string): ChatMessage {
  return {
    id: `mock-${Date.now()}`,
    role: "assistant",
    content:
      `(offline demo answer) Based on verified knowledge items across your org's meetings, here's a traced answer to "${question}". ` +
      "Once /api/v1/chat is live this will be replaced by a real, evidence-grounded response.",
    evidence: [
      {
        id: "chip-1",
        label: "Nimal Perera — Infra Sync, Jul 28 @ 04:05",
        meeting_id: "demo-meeting-1",
        meeting_title: "Infra Sync — Database Migration Planning",
        speaker: "Nimal Perera",
        timestamp_s: 245,
        keyframe_thumbnail_url: "https://placehold.co/120x68/1e293b/e2e8f0?text=Evidence",
      },
      {
        id: "chip-2",
        label: "Kavindi Silva — Infra Sync, Jul 28 @ 14:52",
        meeting_id: "demo-meeting-1",
        meeting_title: "Infra Sync — Database Migration Planning",
        speaker: "Kavindi Silva",
        timestamp_s: 892,
      },
    ],
    created_at: new Date().toISOString(),
  };
}
