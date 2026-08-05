"""Core schema — see docs/PROJECT_PLAN.md § Data model.

Conventions:
- UUID string PKs (generated app-side for cross-store references).
- org_id on every tenant-scoped row; all queries must scope by it.
- Lifecycle STATE lives on knowledge_item; RELATIONS are knowledge_edge rows.
- proposed_action approval gate is a DB CHECK constraint, not app logic.
"""

import enum
import uuid
from datetime import UTC, datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(UTC)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


# --------------------------------------------------------------------------- #
# Tenancy & identity
# --------------------------------------------------------------------------- #


class Org(TimestampMixin, Base):
    __tablename__ = "org"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(255))
    join_policy: Mapped[str] = mapped_column(
        String(32), default="all"
    )  # all | organized_only | never_private
    retention_days: Mapped[int | None] = mapped_column(Integer, default=None)  # None = keep
    settings: Mapped[dict] = mapped_column(JSON, default=dict)


class Person(TimestampMixin, Base):
    """Org-level identity; aliases let 'Nimal' / 'nimal.p' / 'Nimal Perera' resolve to one person."""

    __tablename__ = "person"
    __table_args__ = (Index("ix_person_org", "org_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    display_name: Mapped[str] = mapped_column(String(255))
    email: Mapped[str | None] = mapped_column(String(320), default=None)
    aliases: Mapped[list] = mapped_column(JSON, default=list)


class CalendarConnection(TimestampMixin, Base):
    __tablename__ = "calendar_connection"
    __table_args__ = (Index("ix_calconn_org", "org_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    provider: Mapped[str] = mapped_column(String(32))  # google | microsoft
    account_email: Mapped[str] = mapped_column(String(320))
    # OAuth tokens live in a secret store, not here; this row holds the reference.
    secret_ref: Mapped[str] = mapped_column(String(255))
    watch_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class OrgConnection(TimestampMixin, Base):
    """Non-calendar OAuth vendor grants -- Slack/Jira/GitHub/Linear/Zoom.

    CalendarConnection above predates this and stays as-is for
    google/microsoft (it already had exactly the columns a calendar
    grant needs, no reason to migrate working rows). This table exists
    because those five vendors aren't calendars: no watch_expires_at,
    and account identity varies enough per vendor (a Slack workspace, a
    GitHub username, an Atlassian site) that a single `account_label`
    plus an optional `external_id` (e.g. Jira's cloudId, needed to build
    that vendor's API URLs -- see app/connectors/task_create.py) covers
    all of them without vendor-specific columns."""

    __tablename__ = "org_connection"
    __table_args__ = (
        Index("ix_orgconn_org", "org_id"),
        Index("ix_orgconn_org_provider", "org_id", "provider", unique=True),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    provider: Mapped[str] = mapped_column(String(32))  # slack | jira | github | linear | zoom
    account_label: Mapped[str] = mapped_column(String(320))  # workspace/site/username, human-readable
    external_id: Mapped[str | None] = mapped_column(String(255), default=None)
    # OAuth tokens live in a secret store, not here; this row holds the reference.
    secret_ref: Mapped[str] = mapped_column(String(255))


# --------------------------------------------------------------------------- #
# Meetings & capture
# --------------------------------------------------------------------------- #


class Meeting(TimestampMixin, Base):
    __tablename__ = "meeting"
    __table_args__ = (
        Index("ix_meeting_org_start", "org_id", "scheduled_start"),
        Index("ix_meeting_external_calendar_event", "org_id", "external_calendar_event_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    title: Mapped[str] = mapped_column(String(500), default="")
    platform: Mapped[str] = mapped_column(String(32), default="upload")  # zoom|meet|teams|upload
    platform_meeting_id: Mapped[str | None] = mapped_column(String(255), default=None)
    # Calendar provider's event id (app/orchestrator/scheduler.py) -- distinct
    # from platform_meeting_id (the Zoom/Meet/Teams conferencing id used by
    # capture adapters). Lets repeated calendar polls be idempotent instead
    # of creating a duplicate Meeting per sync for the same event.
    external_calendar_event_id: Mapped[str | None] = mapped_column(String(255), default=None)
    scheduled_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    scheduled_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class CaptureState(enum.StrEnum):
    SCHEDULED = "scheduled"
    ACQUIRING = "acquiring"
    ACQUIRED = "acquired"
    TRANSCRIBING = "transcribing"
    PROCESSING_SCREEN = "processing_screen"
    UNDERSTANDING = "understanding"
    VERIFYING = "verifying"
    REMEMBERING = "remembering"
    PROPOSING = "proposing"
    REPORTING = "reporting"
    DONE = "done"
    FAILED = "failed"


class CaptureSession(TimestampMixin, Base):
    __tablename__ = "capture_session"
    __table_args__ = (Index("ix_capsession_org_state", "org_id", "state"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    meeting_id: Mapped[str] = mapped_column(ForeignKey("meeting.id"))
    mode: Mapped[str] = mapped_column(String(4))  # A1|A2|B|C|D
    state: Mapped[CaptureState] = mapped_column(
        Enum(CaptureState, native_enum=False, length=32), default=CaptureState.SCHEDULED
    )
    disclosure_log: Mapped[list] = mapped_column(JSON, default=list)  # who/when/how disclosed
    error: Mapped[str | None] = mapped_column(Text, default=None)
    # Screen-share/composited recording for keyframe extraction. Optional —
    # audio-only sessions (Mode D audio upload, or a platform with no screen
    # share) simply never get keyframes; the screen stage treats this as a
    # normal case, not a failure (docs/03-capture.md: no silent degradation,
    # but honest absence is not degradation).
    video_uri: Mapped[str | None] = mapped_column(String(1000), default=None)

    meeting: Mapped[Meeting] = relationship()


class AudioTrack(TimestampMixin, Base):
    """One acquired audio track for a capture session — mirrors
    interfaces.platform.AudioTrack. Mode D writes this directly at upload time;
    other modes will write it from PlatformAdapter.acquire() once wired.
    A session with per-participant tracks (Zoom) has one row per participant;
    a mixed-audio session (Meet/Teams/D) has exactly one row with participant
    fields null."""

    __tablename__ = "audio_track"
    __table_args__ = (Index("ix_audiotrack_session", "capture_session_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    capture_session_id: Mapped[str] = mapped_column(ForeignKey("capture_session.id"))
    uri: Mapped[str] = mapped_column(String(1000))
    participant_person_id: Mapped[str | None] = mapped_column(ForeignKey("person.id"), default=None)
    participant_display_name: Mapped[str | None] = mapped_column(String(255), default=None)


class Participant(TimestampMixin, Base):
    __tablename__ = "participant"
    __table_args__ = (Index("ix_participant_session", "capture_session_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    capture_session_id: Mapped[str] = mapped_column(ForeignKey("capture_session.id"))
    person_id: Mapped[str | None] = mapped_column(ForeignKey("person.id"), default=None)
    display_name: Mapped[str] = mapped_column(String(255))
    platform_user_id: Mapped[str | None] = mapped_column(String(255), default=None)


class CoverageStatus(enum.StrEnum):
    OK = "ok"
    DEGRADED = "degraded"
    MISSING = "missing"


class CoverageInterval(TimestampMixin, Base):
    """First-class capture honesty: every span of the meeting is accounted for."""

    __tablename__ = "coverage_interval"
    __table_args__ = (Index("ix_coverage_session", "capture_session_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    capture_session_id: Mapped[str] = mapped_column(ForeignKey("capture_session.id"))
    start_s: Mapped[float] = mapped_column(Float)
    end_s: Mapped[float] = mapped_column(Float)
    modality: Mapped[str] = mapped_column(String(16))  # audio | screen | roster
    status: Mapped[CoverageStatus] = mapped_column(
        Enum(CoverageStatus, native_enum=False, length=16)
    )
    reason: Mapped[str | None] = mapped_column(String(500), default=None)


# --------------------------------------------------------------------------- #
# Evidence: utterances & keyframes
# --------------------------------------------------------------------------- #


class Utterance(TimestampMixin, Base):
    __tablename__ = "utterance"
    __table_args__ = (Index("ix_utterance_session_start", "capture_session_id", "start_s"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    capture_session_id: Mapped[str] = mapped_column(ForeignKey("capture_session.id"))
    person_id: Mapped[str | None] = mapped_column(ForeignKey("person.id"), default=None)
    start_s: Mapped[float] = mapped_column(Float)
    end_s: Mapped[float] = mapped_column(Float)
    text: Mapped[str] = mapped_column(Text)
    lang_tags: Mapped[list] = mapped_column(JSON, default=list)  # ["si","en"] per plan
    asr_confidence: Mapped[float] = mapped_column(Float, default=1.0)
    attribution_confidence: Mapped[float] = mapped_column(Float, default=1.0)
    provider: Mapped[str] = mapped_column(String(64), default="")  # which vendor produced it
    repaired: Mapped[bool] = mapped_column(Boolean, default=False)  # LLM repair pass applied


class Keyframe(TimestampMixin, Base):
    __tablename__ = "keyframe"
    __table_args__ = (Index("ix_keyframe_session_start", "capture_session_id", "valid_from_s"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    capture_session_id: Mapped[str] = mapped_column(ForeignKey("capture_session.id"))
    valid_from_s: Mapped[float] = mapped_column(Float)
    valid_to_s: Mapped[float] = mapped_column(Float)
    image_uri: Mapped[str] = mapped_column(String(1000))
    phash: Mapped[str] = mapped_column(String(64), default="")
    ocr_text: Mapped[str] = mapped_column(Text, default="")
    vlm_caption: Mapped[str] = mapped_column(Text, default="")
    detected_entities: Mapped[list] = mapped_column(JSON, default=list)  # ticket IDs, URLs…


class UtteranceKeyframe(Base):
    """Speech↔screen grounding link."""

    __tablename__ = "utterance_keyframe"
    __table_args__ = (Index("ix_uk_utterance", "utterance_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    utterance_id: Mapped[str] = mapped_column(ForeignKey("utterance.id"))
    keyframe_id: Mapped[str] = mapped_column(ForeignKey("keyframe.id"))
    score: Mapped[float] = mapped_column(Float)  # temporal overlap + lexical boost
    method: Mapped[str] = mapped_column(String(32))  # temporal | lexical | both


# --------------------------------------------------------------------------- #
# Knowledge
# --------------------------------------------------------------------------- #


class KnowledgeType(enum.StrEnum):
    DECISION = "decision"
    COMMITMENT = "commitment"
    REQUIREMENT = "requirement"
    BLOCKER = "blocker"
    QUESTION = "question"
    FACT = "fact"


class LifecycleState(enum.StrEnum):
    NEW = "new"
    RECURRING = "recurring"
    REOPENED = "reopened"
    RESOLVED = "resolved"
    SUPERSEDED = "superseded"


class Confidence(enum.StrEnum):
    VERIFIED = "verified"
    PARTIALLY_SUPPORTED = "partially_supported"
    AMBIGUOUS = "ambiguous"
    UNSUPPORTED = "unsupported"


class KnowledgeItem(TimestampMixin, Base):
    __tablename__ = "knowledge_item"
    __table_args__ = (
        Index("ix_ki_org_type_state", "org_id", "type", "lifecycle_state"),
        Index("ix_ki_session", "capture_session_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    capture_session_id: Mapped[str] = mapped_column(ForeignKey("capture_session.id"))
    type: Mapped[KnowledgeType] = mapped_column(Enum(KnowledgeType, native_enum=False, length=16))
    statement: Mapped[str] = mapped_column(Text)
    owner_person_id: Mapped[str | None] = mapped_column(ForeignKey("person.id"), default=None)
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    lifecycle_state: Mapped[LifecycleState] = mapped_column(
        Enum(LifecycleState, native_enum=False, length=16), default=LifecycleState.NEW
    )
    confidence: Mapped[Confidence] = mapped_column(
        Enum(Confidence, native_enum=False, length=24), default=Confidence.AMBIGUOUS
    )
    confidence_rationale: Mapped[str] = mapped_column(Text, default="")
    overlaps_coverage_gap: Mapped[bool] = mapped_column(Boolean, default=False)
    embedding: Mapped[list[float] | None] = mapped_column(Vector(1024), nullable=True)


class KnowledgeEvidence(Base):
    __tablename__ = "knowledge_evidence"
    __table_args__ = (
        Index("ix_ke_item", "knowledge_item_id"),
        CheckConstraint(
            "(utterance_id IS NOT NULL) OR (keyframe_id IS NOT NULL)",
            name="ck_evidence_has_source",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    knowledge_item_id: Mapped[str] = mapped_column(ForeignKey("knowledge_item.id"))
    utterance_id: Mapped[str | None] = mapped_column(ForeignKey("utterance.id"), default=None)
    keyframe_id: Mapped[str | None] = mapped_column(ForeignKey("keyframe.id"), default=None)
    role: Mapped[str] = mapped_column(String(32), default="primary")  # primary | corroborating


class EdgeKind(enum.StrEnum):
    SUPERSEDES = "supersedes"
    CONTRADICTS = "contradicts"
    CONTINUES = "continues"
    RECURS = "recurs"
    RESOLVES = "resolves"


class KnowledgeEdge(TimestampMixin, Base):
    __tablename__ = "knowledge_edge"
    __table_args__ = (
        Index("ix_edge_from", "from_item_id"),
        Index("ix_edge_to", "to_item_id"),
        CheckConstraint("from_item_id != to_item_id", name="ck_edge_no_self"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    from_item_id: Mapped[str] = mapped_column(ForeignKey("knowledge_item.id"))
    to_item_id: Mapped[str] = mapped_column(ForeignKey("knowledge_item.id"))
    kind: Mapped[EdgeKind] = mapped_column(Enum(EdgeKind, native_enum=False, length=16))
    rationale: Mapped[str] = mapped_column(Text, default="")


# --------------------------------------------------------------------------- #
# Actions (human-gated), corrections, consent, audit
# --------------------------------------------------------------------------- #


class ActionStatus(enum.StrEnum):
    PENDING_APPROVAL = "pending_approval"
    APPROVED = "approved"
    REJECTED = "rejected"
    EXECUTED = "executed"
    FAILED = "failed"


class ProposedAction(TimestampMixin, Base):
    """Never auto-executed. The CHECK constraint makes an unapproved execution
    unrepresentable in the database, not merely forbidden by app code."""

    __tablename__ = "proposed_action"
    __table_args__ = (
        Index("ix_action_org_status", "org_id", "status"),
        CheckConstraint(
            "status NOT IN ('approved','executed') OR approved_by_person_id IS NOT NULL",
            name="ck_action_requires_approval",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    capture_session_id: Mapped[str] = mapped_column(ForeignKey("capture_session.id"))
    kind: Mapped[str] = mapped_column(String(32))  # ActionKind values
    payload: Mapped[dict] = mapped_column(JSON)
    status: Mapped[ActionStatus] = mapped_column(
        Enum(ActionStatus, native_enum=False, length=24), default=ActionStatus.PENDING_APPROVAL
    )
    approved_by_person_id: Mapped[str | None] = mapped_column(ForeignKey("person.id"), default=None)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    executed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    external_url: Mapped[str | None] = mapped_column(String(1000), default=None)
    error: Mapped[str | None] = mapped_column(Text, default=None)


class Correction(TimestampMixin, Base):
    """User transcript/entity fixes — product feature now, si-ta-en corpus forever."""

    __tablename__ = "correction"
    __table_args__ = (Index("ix_correction_org", "org_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    utterance_id: Mapped[str] = mapped_column(ForeignKey("utterance.id"))
    corrected_by_person_id: Mapped[str | None] = mapped_column(
        ForeignKey("person.id"), default=None
    )
    original_text: Mapped[str] = mapped_column(Text)
    corrected_text: Mapped[str] = mapped_column(Text)
    training_consent: Mapped[bool] = mapped_column(Boolean, default=False)


class GlossaryTerm(TimestampMixin, Base):
    """Org-level biasing lexicon for the LLM repair pass (app/asr/repair.py):
    ticket ID patterns, Sri Lankan personal names, technical terms. Populated
    two ways — directly via the glossary UI, or implicitly whenever a
    correction names a term worth remembering (source_correction_id set)."""

    __tablename__ = "glossary_term"
    __table_args__ = (Index("ix_glossary_org", "org_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    term: Mapped[str] = mapped_column(String(255))
    added_by_person_id: Mapped[str | None] = mapped_column(ForeignKey("person.id"), default=None)
    source_correction_id: Mapped[str | None] = mapped_column(ForeignKey("correction.id"), default=None)


class ConsentRecord(TimestampMixin, Base):
    __tablename__ = "consent_record"
    __table_args__ = (Index("ix_consent_session", "capture_session_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    capture_session_id: Mapped[str] = mapped_column(ForeignKey("capture_session.id"))
    subject: Mapped[str] = mapped_column(String(255))  # who consented (or was notified)
    method: Mapped[str] = mapped_column(
        String(64)
    )  # bot_disclosure | chat_announcement | host_setting
    detail: Mapped[str] = mapped_column(Text, default="")


class AuditLog(Base):
    __tablename__ = "audit_log"
    __table_args__ = (Index("ix_audit_org_at", "org_id", "at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    actor: Mapped[str] = mapped_column(String(255))  # person id or "system"
    event: Mapped[str] = mapped_column(String(64))
    detail: Mapped[dict] = mapped_column(JSON, default=dict)


# --------------------------------------------------------------------------- #
# Pipeline job queue (Postgres-backed FSM; FOR UPDATE SKIP LOCKED)
# --------------------------------------------------------------------------- #


class JobStatus(enum.StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


class PipelineJob(TimestampMixin, Base):
    __tablename__ = "pipeline_job"
    __table_args__ = (Index("ix_job_status_runat", "status", "run_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    capture_session_id: Mapped[str] = mapped_column(ForeignKey("capture_session.id"))
    stage: Mapped[str] = mapped_column(
        String(32)
    )  # acquire|transcribe|understand|verify|remember|propose|report
    status: Mapped[JobStatus] = mapped_column(
        Enum(JobStatus, native_enum=False, length=16), default=JobStatus.QUEUED
    )
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=5)
    run_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    locked_by: Mapped[str | None] = mapped_column(String(64), default=None)
    locked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    error: Mapped[str | None] = mapped_column(Text, default=None)
