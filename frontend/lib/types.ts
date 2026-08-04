// ---------------------------------------------------------------------------
// Types mirroring the REAL backend API (backend/app/api/upload.py).
// ---------------------------------------------------------------------------

/** Response body of POST /api/v1/meetings/upload */
export interface UploadResponse {
  meeting_id: string;
  capture_session_id: string;
  audio_uri: string;
  state: CaptureSessionState;
}

/**
 * Capture session FSM states, mirroring CaptureSessionState in
 * backend/app/db/models.py. Order below is the pipeline progression order.
 */
export type CaptureSessionState =
  | "scheduled"
  | "acquiring"
  | "acquired"
  | "transcribing"
  | "processing_screen"
  | "understanding"
  | "verifying"
  | "remembering"
  | "proposing"
  | "reporting"
  | "done"
  | "failed";

export const CAPTURE_SESSION_STATE_ORDER: CaptureSessionState[] = [
  "scheduled",
  "acquiring",
  "acquired",
  "transcribing",
  "processing_screen",
  "understanding",
  "verifying",
  "remembering",
  "proposing",
  "reporting",
  "done",
];

/** Response body of GET /api/v1/meetings/sessions/{session_id} */
export interface CaptureSessionStatus {
  id: string;
  meeting_id: string;
  mode: string;
  state: CaptureSessionState;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Types for the report page. The endpoint that serves these does NOT exist
// yet (other agents are building the pipeline that produces report data).
// Shape is derived from docs/01-vision-and-competitive.md (product surfaces)
// and docs/05-data-model.md (knowledge_item / knowledge_evidence / keyframe).
// ---------------------------------------------------------------------------

/** Mirrors knowledge_item.type in docs/05-data-model.md */
export type KnowledgeItemType =
  | "decision"
  | "commitment"
  | "requirement"
  | "blocker"
  | "question"
  | "fact";

/** Mirrors knowledge_item.lifecycle_state. Values are lowercase, matching the
 * backend's LifecycleState StrEnum (backend/app/db/models.py) as serialized
 * by report.py's `.value` — not the uppercase display convention. */
export type LifecycleState =
  | "new"
  | "recurring"
  | "reopened"
  | "resolved"
  | "superseded";

/**
 * Confidence badge shown on every knowledge item. Verification never sees
 * the extractor's reasoning (CLAUDE.md rule #3) — this is the output of
 * that independent verification step, surfaced to the user.
 */
export type ConfidenceLevel =
  | "verified"
  | "partially_supported"
  | "ambiguous"
  | "unsupported";

/** A single piece of evidence backing a knowledge item (knowledge_evidence -> utterance/keyframe). */
export interface EvidenceRef {
  id: string;
  speaker: string;
  /** Seconds from meeting start. */
  timestamp_s: number;
  /** Verbatim or near-verbatim quoted span from the utterance, if applicable.
   * Never translated -- report/summary text is normalized to English, but a
   * quote must stay exactly what was said, which is what quote_lang_tags labels. */
  quote?: string;
  /** e.g. ["si","en"] -- language(s) detected in the quote span, for a "(Sinhala)" label in the UI. */
  quote_lang_tags?: string[];
  /** Inline screenshot thumbnail URL for screen evidence (keyframe.image_uri). Product requirement: inline, not a link. */
  keyframe_thumbnail_url?: string;
  /** OCR / VLM caption text extracted from the keyframe, for accessibility and context. */
  keyframe_caption?: string;
}

/** A single row in the meeting report (knowledge_item + its evidence). */
export interface KnowledgeItem {
  id: string;
  type: KnowledgeItemType;
  statement: string;
  owner?: string;
  due?: string; // ISO date
  confidence: ConfidenceLevel;
  lifecycle_state: LifecycleState;
  rationale?: string;
  /** True if this item overlaps a coverage_interval gap (capture honesty). */
  coverage_gap: boolean;
  evidence: EvidenceRef[];
}

/** Mirrors coverage_interval rows relevant to this meeting. */
export interface CoverageGap {
  id: string;
  modality: "audio" | "video" | "screen";
  status: "degraded" | "missing";
  reason: string;
  start_s: number;
  end_s: number;
}

/** Per-participant talk time -- backend/app/api/report.py's engagement summary. */
export interface ParticipantEngagement {
  person_id: string | null;
  display_name: string;
  talk_time_s: number;
  utterance_count: number;
  /** Share of total attributed talk time in this session, 0-100. */
  talk_time_pct: number;
}

export interface EngagementSummary {
  total_talk_time_s: number;
  /** Sorted by talk_time_s descending. */
  participants: ParticipantEngagement[];
}

/**
 * Shape of GET /api/v1/meetings/{capture_session_id}/report
 * (backend/app/api/report.py). Note the path param is a capture_session_id,
 * not a meeting_id — a meeting can in principle have more than one capture
 * session, so the report is scoped to one session's evidence.
 */
export interface MeetingReport {
  meeting_id: string;
  capture_session_id: string;
  title: string;
  occurred_at: string; // ISO date
  coverage_gaps: CoverageGap[];
  engagement: EngagementSummary;
  decisions: KnowledgeItem[];
  commitments: KnowledgeItem[];
  requirements: KnowledgeItem[];
  blockers: KnowledgeItem[];
  questions: KnowledgeItem[];
  facts: KnowledgeItem[];
}

// ---------------------------------------------------------------------------
// Types for the org-memory chat page. app/chat/page.tsx is wired to the real
// POST /api/v1/chat (backend/app/api/chat.py), falling back to
// lib/mock-data.ts's mockAssistantReply only when that fetch fails. Shape
// derived from docs/01-vision-and-competitive.md ("every claim cites
// clickable evidence chips") and the north-star acceptance test ("why are we
// using MongoDB?" -> traced answer with speaker/span/screen).
// ---------------------------------------------------------------------------

export interface ChatRequest {
  org_id: string;
  question: string;
  /** Prior turns, oldest first, for follow-up questions. */
  history: ChatMessage[];
}

export interface EvidenceChip {
  id: string;
  label: string; // e.g. "Nimal, 14:32 in 'Infra sync – Jul 28'"
  meeting_id: string;
  meeting_title: string;
  speaker: string;
  timestamp_s: number;
  keyframe_thumbnail_url?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Only present on assistant messages that cite grounded evidence. */
  evidence?: EvidenceChip[];
  created_at: string; // ISO datetime
}

/** Expected future shape of POST /api/v1/chat response. */
export interface ChatResponse {
  message: ChatMessage;
}

// ---------------------------------------------------------------------------
// Types for the correction & glossary UI (backend/app/api/corrections.py).
// ---------------------------------------------------------------------------

/** Response row of GET /api/v1/meetings/{capture_session_id}/utterances */
export interface UtteranceOut {
  id: string;
  start_s: number;
  end_s: number;
  text: string;
  lang_tags: string[];
  speaker: string;
  asr_confidence: number;
  repaired: boolean;
}

/** Request body of POST /api/v1/corrections */
export interface CorrectionRequest {
  utterance_id: string;
  corrected_text: string;
  training_consent?: boolean;
  corrected_by_person_id?: string;
  /** Optional: also remember this term for future LLM repair passes. */
  glossary_term?: string;
}

/** Response body of POST /api/v1/corrections */
export interface CorrectionResponse {
  id: string;
  utterance_id: string;
  original_text: string;
  corrected_text: string;
  glossary_term_id: string | null;
}

/** Row shape of GET/POST /api/v1/orgs/{org_id}/glossary */
export interface GlossaryTermOut {
  id: string;
  term: string;
  added_by: string | null;
  created_at: string; // ISO datetime
}

// ---------------------------------------------------------------------------
// Types for the action-approval UI (backend/app/api/actions.py).
// ---------------------------------------------------------------------------

/** Mirrors ActionKind in backend/app/interfaces/actions.py */
export type ActionKind =
  | "email_draft"
  | "channel_recap"
  | "task_create"
  | "calendar_followup"
  | "escalation"
  | "reminder";

/** Mirrors ActionStatus in backend/app/db/models.py */
export type ActionStatusValue = "pending_approval" | "approved" | "rejected" | "executed" | "failed";

/** Row shape of GET /api/v1/orgs/{org_id}/actions and the approve/reject responses */
export interface ProposedActionOut {
  id: string;
  capture_session_id: string;
  kind: string;
  title: string;
  body: string;
  target: Record<string, string>;
  status: ActionStatusValue;
  approved_by: string | null;
  approved_at: string | null;
  executed_at: string | null;
  external_url: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Types for the data-rights UI (backend/app/api/data_rights.py) -- PDPA
// export/erasure per meeting, plus org retention settings.
// ---------------------------------------------------------------------------

/** Response body of GET /api/v1/orgs/{org_id}/meetings/{meeting_id}/export.
 * Loosely typed to match the backend's raw dict return -- this is a
 * portability dump, not a UI-driving shape, so only the fields the export
 * page actually renders are named; everything else is pass-through JSON. */
export interface ExportedMeetingData {
  meeting_id: string;
  title: string;
  platform: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  capture_sessions: Array<{
    capture_session_id: string;
    mode: string;
    state: string;
    utterances: Array<{ start_s: number; end_s: number; text: string }>;
    audio_tracks: Array<{ uri: string }>;
    keyframes: Array<{ image_uri: string }>;
    knowledge_items: Array<{ type: string; statement: string }>;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

/** Response body of DELETE /api/v1/orgs/{org_id}/meetings/{meeting_id} */
export interface EraseMeetingResponse {
  meeting_id: string;
  erased: boolean;
}

/** Response body of GET/PATCH /api/v1/orgs/{org_id}/settings */
export interface OrgSettingsOut {
  org_id: string;
  retention_days: number | null;
  join_policy: string;
}
