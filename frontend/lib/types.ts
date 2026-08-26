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
  | "diarizing"
  | "identifying"
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
  "diarizing",
  "identifying",
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

export interface InstantCaptureResponse {
  platform: string;
  dispatched: boolean;
  meeting_id: string | null;
  bot_session_id: string | null;
  note: string;
  admission_guidance: string | null;
}

export type BotSessionStatus =
  | "scheduled"
  | "joining"
  | "in_lobby"
  | "live"
  | "ended"
  | "missed"
  | "failed"
  | "lobby_timeout";

export interface BotSessionStatusResponse {
  id: string;
  status: BotSessionStatus;
  platform: string;
  scheduled_start: string | null;
  joined_at: string | null;
  ended_at: string | null;
  lobby_timeout_at: string | null;
  error: string | null;
  capture_session_id: string | null;
}

export interface MeetingListItem {
  id: string;
  title: string;
  platform: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  latest_capture_session_id: string | null;
  latest_capture_mode: string | null;
  latest_capture_state: CaptureSessionState | null;
  latest_capture_error: string | null;
  latest_bot_session_id: string | null;
  latest_bot_status: BotSessionStatus | null;
  latest_bot_error: string | null;
  has_coverage_gap: boolean;
}

// ---------------------------------------------------------------------------
// Types for the report page. The endpoint that serves these does NOT exist
// yet (other agents are building the pipeline that produces report data).
// Shape is derived from docs/01-vision-and-competitive.md (product surfaces)
// and docs/05-data-model.md (knowledge_item / knowledge_evidence / keyframe).
// ---------------------------------------------------------------------------

/** Mirrors knowledge_item.type in docs/05-data-model.md */
export type KnowledgeItemType =
  "decision" | "commitment" | "requirement" | "blocker" | "question" | "fact";

/** Mirrors knowledge_item.lifecycle_state. Values are lowercase, matching the
 * backend's LifecycleState StrEnum (backend/app/db/models.py) as serialized
 * by report.py's `.value` — not the uppercase display convention. */
export type LifecycleState =
  "new" | "recurring" | "reopened" | "resolved" | "superseded";

/**
 * Confidence badge shown on every knowledge item. Verification never sees
 * the extractor's reasoning (CLAUDE.md rule #3) — this is the output of
 * that independent verification step, surfaced to the user.
 */
export type ConfidenceLevel =
  "verified" | "partially_supported" | "ambiguous" | "unsupported";

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

/** Speech-captured-per-speaker summary -- not a contribution score. */
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
  executive_summary?: string | null; // LLM-generated; null until report stage completes
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
  speaker_cluster_id: string | null;
  session_speaker_id: string | null;
  person_id: string | null;
  attribution_confidence: number;
  asr_confidence: number;
  repaired: boolean;
}

export interface PersonOptionOut {
  id: string;
  display_name: string;
  email: string | null;
}

export interface SessionSpeakerOut {
  id: string;
  cluster_id: string;
  person_id: string | null;
  display_name: string | null;
  resolution_method: string;
  confidence: number;
  utterance_count: number;
}

export interface MeetingSpeakersOut {
  people: PersonOptionOut[];
  speakers: SessionSpeakerOut[];
}

export interface SpeakerCorrectionResponse {
  session_speaker_id: string;
  person_id: string | null;
  display_name: string | null;
  utterance_ids: string[];
  updated_owner_item_ids: string[];
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
export type ActionStatusValue =
  "pending_approval" | "approved" | "rejected" | "executed" | "failed";

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
  external_id: string | null;
  external_url: string | null;
  error: string | null;
}

export interface PersonListItem {
  id: string;
  display_name: string;
  email: string | null;
  user_id: string | null;
  open_commitments: number;
  overdue_commitments: number;
}

export interface BlockerRef {
  id: string;
  statement: string;
  confidence: string;
}

export interface PersonKnowledgeOut {
  id: string;
  type: string;
  statement: string;
  lifecycle_state: string;
  confidence: string;
  due_at: string | null;
  owner_source: string | null;
  owner_confidence: number | null;
  meeting_id: string;
  capture_session_id: string;
  meeting_title: string;
  occurred_at: string;
  coverage_gap: boolean;
  evidence_url: string;
  blockers: BlockerRef[];
}

export interface CoverageDisclosure {
  utterance_count: number;
  low_confidence_or_gap_count: number;
  excluded_item_count: number;
}

export interface PersonDetail {
  id: string;
  display_name: string;
  email: string | null;
  user_id: string | null;
  commitments: PersonKnowledgeOut[];
  decisions_authored: PersonKnowledgeOut[];
  coverage: CoverageDisclosure;
}

export interface LongitudinalFindingOut {
  id: string;
  kind: string;
  statement: string;
  confidence: string;
  audit_status: string;
  sample_size: number;
  evidence: PersonKnowledgeOut[];
}

export interface LifecycleHopOut {
  edge_id: string;
  from_item_id: string;
  to_item_id: string;
  kind: string;
  rationale: string;
  from_statement: string;
  from_meeting_title: string;
  from_occurred_at: string;
  evidence_url: string;
}

export interface PersonAnalysisOut {
  available: boolean;
  run_id: string | null;
  state: string | null;
  summary: string;
  coverage: Record<string, number>;
  findings: LongitudinalFindingOut[];
  commitment_timeline: PersonKnowledgeOut[];
  follow_through_trend: Array<{
    period: string;
    delivered: number;
    total: number;
    coverage_gap: boolean;
    evidence_url: string | null;
  }>;
  recurrence_heat_strip: PersonKnowledgeOut[][];
  decision_evolution: LifecycleHopOut[];
  commitment_funnel: {
    stated: number;
    open: number;
    recurring: number;
    blocked: number;
    delivered: number;
  } | null;
  status_distribution: Record<string, number>;
}

export interface InteractionMapOut {
  nodes: Array<{ person_id: string; display_name: string }>;
  edges: Array<{
    from_person_id: string;
    to_person_id: string;
    kind: string;
    weight: number;
    evidence_url: string;
  }>;
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

/** Element of GET /api/v1/orgs/{org_id}/connections */
export interface ConnectionOut {
  provider: string;
  account_label: string;
  connected_at: string;
  teams_scope_granted: boolean;
}
