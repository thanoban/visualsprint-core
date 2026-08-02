// ---------------------------------------------------------------------------
// MOCK DATA BOUNDARY
//
// The report page is wired to the real endpoint now
// (GET /api/v1/meetings/{capture_session_id}/report, see
// app/meetings/[id]/report/page.tsx) -- its fixture has been removed from
// this file.
//
// `mockAssistantReply` below is intentionally still used, as an offline
// fallback in app/chat/page.tsx when POST /api/v1/chat is unreachable (not a
// TODO -- see that page's catch block). This is the ONLY function that
// should remain in this file; do not add report-shaped fixtures back here.
// ---------------------------------------------------------------------------

import type { ChatMessage } from "./types";

/** Offline fallback for the chat page when the backend is unreachable — see
 * app/chat/page.tsx's catch block. Not a placeholder for missing backend
 * functionality; POST /api/v1/chat is real and used first. */
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
