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
from decimal import Decimal
from typing import Any

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
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
    # Monthly LLM token ceiling (input+output, see app/orchestrator/
    # llm_accounting.py). None = unlimited, which is every org's default --
    # this exists so a budget-constrained deploy can put a hard floor under
    # runaway agent spend, not to meter normal use.
    monthly_llm_token_budget: Mapped[int | None] = mapped_column(Integer, default=None)
    settings: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    timezone: Mapped[str] = mapped_column(String(64), default="UTC")
    preferred_language: Mapped[str] = mapped_column(String(16), default="en")
    capture_policy: Mapped[str] = mapped_column(String(32), default="off")
    capture_concurrency_limit: Mapped[int] = mapped_column(Integer, default=5)
    capture_monthly_minutes: Mapped[int] = mapped_column(Integer, default=6000)
    disclosure_ack_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )
    disclosure_ack_by: Mapped[str | None] = mapped_column(
        ForeignKey("app_user.id"), default=None
    )


class Person(TimestampMixin, Base):
    """Org-level identity; aliases let 'Nimal' / 'nimal.p' / 'Nimal Perera' resolve to one person."""

    __tablename__ = "person"
    __table_args__ = (
        Index("ix_person_org", "org_id"),
        # Voiceprint matching (app/speakers/identity.py) currently scores in
        # Python over the org's roster, which is small; the index is here so
        # the query can move into Postgres without a schema change first.
        Index(
            "ix_person_voiceprint_hnsw",
            "voiceprint",
            postgresql_using="hnsw",
            postgresql_ops={"voiceprint": "vector_cosine_ops"},
        ).ddl_if(dialect="postgresql"),
        Index("ix_person_org_email", "org_id", "email"),
        Index("ix_person_org_user", "org_id", "user_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    user_id: Mapped[str | None] = mapped_column(ForeignKey("app_user.id"), default=None)
    display_name: Mapped[str] = mapped_column(String(255))
    email: Mapped[str | None] = mapped_column(String(320), default=None)
    aliases: Mapped[list[Any]] = mapped_column(JSON, default=list)
    # Enrolled voice centroid — what carries identity from one meeting to the
    # next (docs/08-speaker-identity.md Phase B). 512 dims read empirically
    # from pyannote/embedding's real output, not assumed from documentation.
    # Derived from resolved SessionSpeaker rows rather than updated as a
    # running mean, so re-running/correcting a session cannot double-count or
    # leave stale voice in the centroid.
    voiceprint: Mapped[list[float] | None] = mapped_column(Vector(512), nullable=True)
    voiceprint_sample_count: Mapped[int] = mapped_column(Integer, default=0)
    voiceprint_reliable: Mapped[bool] = mapped_column(Boolean, default=True)


class User(TimestampMixin, Base):
    """An authenticated end user (app/auth/) -- distinct from `Person`, which
    is org-scoped meeting-participant identity ('Nimal' in a transcript) and
    has no login of its own. `id` is Supabase's own JWT `sub` claim (a UUID
    string) reused directly as the primary key, not a second identity minted
    here and kept in sync."""

    # "user" is a reserved word in Postgres -- sidestep it entirely rather
    # than rely on dialect auto-quoting for a security-critical table.
    __tablename__ = "app_user"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    email: Mapped[str] = mapped_column(String(320))
    display_name: Mapped[str | None] = mapped_column(String(255), default=None)


class OrgMember(TimestampMixin, Base):
    """Which `User`s belong to which `Org` -- the same row shape serves a
    solo individual's personal org (one member) and a team org (many), so
    "individual" vs. "team" is never a separate code path, just a member
    count. `role` exists as a column now so a future permissions model
    doesn't need a migration to add it, but nothing enforces it yet beyond
    membership itself -- see docs/EXTERNAL_SETUP.md-adjacent plan notes."""

    __tablename__ = "org_member"
    __table_args__ = (
        Index("ix_orgmember_org_user", "org_id", "user_id", unique=True),
        Index("ix_orgmember_user", "user_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    user_id: Mapped[str] = mapped_column(ForeignKey("app_user.id"))
    role: Mapped[str] = mapped_column(String(32), default="owner")


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
    # Microsoft only: set once the org has completed the separate
    # incremental-consent step (provider="microsoft_teams" in
    # app/oauth/providers.py) that grants OnlineMeetings.Read.All --
    # requesting that scope in the base "microsoft" connect flow would
    # reject the entire grant for personal Microsoft accounts, so it's
    # requested here instead, only for orgs that explicitly opt in. False
    # for every "google" row; irrelevant there but simpler than a second
    # nullable-vs-not split for one platform-specific flag.
    teams_scope_granted: Mapped[bool] = mapped_column(Boolean, default=False)


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
    account_label: Mapped[str] = mapped_column(
        String(320)
    )  # workspace/site/username, human-readable
    external_id: Mapped[str | None] = mapped_column(String(255), default=None)
    # OAuth tokens live in a secret store, not here; this row holds the reference.
    secret_ref: Mapped[str] = mapped_column(String(255))


class CustomerStatus(enum.StrEnum):
    ACTIVE = "active"
    ARCHIVED = "archived"


class Customer(TimestampMixin, Base):
    __tablename__ = "customer"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_customer_org_id"),
        Index("ix_customer_org_status", "org_id", "status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    name: Mapped[str] = mapped_column(String(255))
    status: Mapped[CustomerStatus] = mapped_column(
        Enum(CustomerStatus, native_enum=False, length=16), default=CustomerStatus.ACTIVE
    )
    version: Mapped[int] = mapped_column(Integer, default=1)


class CustomerContact(TimestampMixin, Base):
    __tablename__ = "customer_contact"
    __table_args__ = (
        ForeignKeyConstraint(
            ["org_id", "customer_id"], ["customer.org_id", "customer.id"]
        ),
        UniqueConstraint("customer_id", "email", name="uq_customer_contact_email"),
        Index("ix_customer_contact_org_email", "org_id", "email"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    customer_id: Mapped[str] = mapped_column(String(36))
    email: Mapped[str] = mapped_column(String(320))
    display_name: Mapped[str | None] = mapped_column(String(255), default=None)
    verified_rule: Mapped[bool] = mapped_column(Boolean, default=False)


class ProjectVisibility(enum.StrEnum):
    PRIVATE = "private"


class ProjectStatus(enum.StrEnum):
    ACTIVE = "active"
    ARCHIVED = "archived"


class Project(TimestampMixin, Base):
    __tablename__ = "project"
    __table_args__ = (
        ForeignKeyConstraint(
            ["org_id", "customer_id"], ["customer.org_id", "customer.id"]
        ),
        UniqueConstraint("org_id", "id", name="uq_project_org_id"),
        Index("ix_project_org_status", "org_id", "status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    customer_id: Mapped[str | None] = mapped_column(String(36), default=None)
    name: Mapped[str] = mapped_column(String(255))
    visibility: Mapped[ProjectVisibility] = mapped_column(
        Enum(ProjectVisibility, native_enum=False, length=16), default=ProjectVisibility.PRIVATE
    )
    status: Mapped[ProjectStatus] = mapped_column(
        Enum(ProjectStatus, native_enum=False, length=16), default=ProjectStatus.ACTIVE
    )
    version: Mapped[int] = mapped_column(Integer, default=1)


class ProjectRole(enum.StrEnum):
    OWNER = "owner"
    EDITOR = "editor"
    VIEWER = "viewer"


class ProjectMember(TimestampMixin, Base):
    __tablename__ = "project_member"
    __table_args__ = (
        ForeignKeyConstraint(["org_id", "project_id"], ["project.org_id", "project.id"]),
        UniqueConstraint("project_id", "user_id", name="uq_project_member_user"),
        Index("ix_project_member_org_user", "org_id", "user_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    project_id: Mapped[str] = mapped_column(String(36))
    user_id: Mapped[str] = mapped_column(ForeignKey("app_user.id"))
    role: Mapped[ProjectRole] = mapped_column(
        Enum(ProjectRole, native_enum=False, length=16), default=ProjectRole.VIEWER
    )


# --------------------------------------------------------------------------- #
# Meetings & capture
# --------------------------------------------------------------------------- #


class Meeting(TimestampMixin, Base):
    __tablename__ = "meeting"
    __table_args__ = (
        Index("ix_meeting_org_start", "org_id", "scheduled_start"),
        Index("ix_meeting_external_calendar_event", "org_id", "external_calendar_event_id"),
        UniqueConstraint("org_id", "id", name="uq_meeting_org_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    owner_user_id: Mapped[str | None] = mapped_column(ForeignKey("app_user.id"), default=None)
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


class CalendarOccurrenceStatus(enum.StrEnum):
    SCHEDULED = "scheduled"
    CANCELLED = "cancelled"
    ENDED = "ended"


class CalendarOccurrence(TimestampMixin, Base):
    """One instance of a calendar event (recurring or one-off).

    `original_start` is the scheduled start at the time the occurrence was
    first seen — it identifies this slot within a recurring series and never
    changes on reschedule. `start_time` and `end_time` reflect the current
    (possibly rescheduled) times. `revision` increments on every reschedule.
    """

    __tablename__ = "calendar_occurrence"
    __table_args__ = (
        UniqueConstraint(
            "connection_id", "provider_event_id",
            name="uq_occurrence_connection_event",
        ),
        Index("ix_occurrence_org_start", "org_id", "start_time"),
        Index("ix_occurrence_connection", "connection_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    connection_id: Mapped[str] = mapped_column(ForeignKey("calendar_connection.id"))
    provider_event_id: Mapped[str] = mapped_column(String(255))
    original_start: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    start_time: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    end_time: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    title: Mapped[str] = mapped_column(String(500), default="")
    meeting_url: Mapped[str | None] = mapped_column(String(2048), default=None)
    platform: Mapped[str | None] = mapped_column(String(32), default=None)
    platform_meeting_id: Mapped[str | None] = mapped_column(String(255), default=None)
    status: Mapped[CalendarOccurrenceStatus] = mapped_column(
        Enum(CalendarOccurrenceStatus, native_enum=False, length=16),
        default=CalendarOccurrenceStatus.SCHEDULED,
    )
    revision: Mapped[int] = mapped_column(Integer, default=1)
    # "on" | "off" | null (null means inherit the workspace capture policy)
    capture_override: Mapped[str | None] = mapped_column(String(8), default=None)
    meeting_id: Mapped[str | None] = mapped_column(ForeignKey("meeting.id"), default=None)


class MeetingAssignmentSource(enum.StrEnum):
    MANUAL = "manual"
    APPROVED_RULE = "approved_rule"


class MeetingAssignment(TimestampMixin, Base):
    __tablename__ = "meeting_assignment"
    __table_args__ = (
        ForeignKeyConstraint(["org_id", "meeting_id"], ["meeting.org_id", "meeting.id"]),
        ForeignKeyConstraint(["org_id", "project_id"], ["project.org_id", "project.id"]),
        UniqueConstraint("meeting_id", name="uq_meeting_assignment_meeting"),
        Index("ix_meeting_assignment_project", "project_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    meeting_id: Mapped[str] = mapped_column(String(36))
    project_id: Mapped[str] = mapped_column(String(36))
    assigned_by: Mapped[str] = mapped_column(ForeignKey("app_user.id"))
    source: Mapped[MeetingAssignmentSource] = mapped_column(
        Enum(MeetingAssignmentSource, native_enum=False, length=24),
        default=MeetingAssignmentSource.MANUAL,
    )
    version: Mapped[int] = mapped_column(Integer, default=1)


class CaptureState(enum.StrEnum):
    SCHEDULED = "scheduled"
    ACQUIRING = "acquiring"
    ACQUIRED = "acquired"
    DIARIZING = "diarizing"
    IDENTIFYING = "identifying"
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
    __table_args__ = (
        Index("ix_capsession_org_state", "org_id", "state"),
        # Mode A1 only: lets a `meeting.rtms_stopped` webhook find its session
        # from the DB rather than from a process-local dict. Zoom can deliver
        # the stop event to a different API container than the one that took
        # the start event, and the in-memory registry made that a silent 404
        # with the whole capture lost. See app/api/rtms_webhook.py.
        Index("ix_capsession_rtms_stream", "rtms_stream_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    meeting_id: Mapped[str] = mapped_column(ForeignKey("meeting.id"))
    rtms_stream_id: Mapped[str | None] = mapped_column(String(128), default=None)
    mode: Mapped[str] = mapped_column(String(4))  # A1|A2|B|C|D
    state: Mapped[CaptureState] = mapped_column(
        Enum(CaptureState, native_enum=False, length=32), default=CaptureState.SCHEDULED
    )
    disclosure_log: Mapped[list[Any]] = mapped_column(JSON, default=list)  # who/when/how disclosed
    error: Mapped[str | None] = mapped_column(Text, default=None)
    # Screen-share/composited recording for keyframe extraction. Optional —
    # audio-only sessions (Mode D audio upload, or a platform with no screen
    # share) simply never get keyframes; the screen stage treats this as a
    # normal case, not a failure (docs/03-capture.md: no silent degradation,
    # but honest absence is not degradation).
    video_uri: Mapped[str | None] = mapped_column(String(1000), default=None)
    # Written by the report pipeline stage after run_report_intelligence.
    report_title: Mapped[str | None] = mapped_column(String(500), default=None)
    report_summary: Mapped[str | None] = mapped_column(Text, default=None)

    meeting: Mapped[Meeting] = relationship()


class BotStatus(enum.StrEnum):
    """Lifecycle of one Mode B (bot-join) attempt (docs/03-capture.md Mode B).

    Distinct from CaptureState: a BotSession tracks the *join/record* half of
    capture (did the bot get into the room and record audio); CaptureState
    tracks the *pipeline* half (acquire -> ... -> report) that starts once
    the bot's recording lands in blob storage. One BotSession feeds at most
    one CaptureSession.
    """

    SCHEDULED = "scheduled"
    JOINING = "joining"
    IN_LOBBY = "in_lobby"
    LIVE = "live"
    ENDED = "ended"
    MISSED = "missed"  # scheduled_start too far past to attempt join; session expired by the sweep
    FAILED = "failed"
    LOBBY_TIMEOUT = "lobby_timeout"


class BotSession(TimestampMixin, Base):
    """One dispatched meeting-bot attempt (app/bot/runner.py). Created by the
    scheduler for calendar-discovered Meet/Teams meetings, or on-demand for
    an instant "capture now" request; a worker sweep launches it around
    `scheduled_start` and updates `status` as the join progresses. Getting
    stuck in the lobby and never admitted is a first-class outcome
    (LOBBY_TIMEOUT), not a hang -- see docs/03-capture.md's note on Teams's
    "Unverified" guest-bot gate."""

    __tablename__ = "bot_session"
    __table_args__ = (
        Index("ix_botsession_org_status", "org_id", "status"),
        Index("ix_botsession_scheduled_start", "scheduled_start"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    meeting_id: Mapped[str | None] = mapped_column(ForeignKey("meeting.id"), default=None)
    platform: Mapped[str] = mapped_column(String(32))  # meet | teams | zoom -- matches Meeting.platform
    join_url: Mapped[str] = mapped_column(Text)
    status: Mapped[BotStatus] = mapped_column(
        Enum(BotStatus, native_enum=False, length=32), default=BotStatus.SCHEDULED
    )
    scheduled_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    joined_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    lobby_timeout_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    audio_blob_uri: Mapped[str | None] = mapped_column(String(1000), default=None)
    capture_session_id: Mapped[str | None] = mapped_column(
        ForeignKey("capture_session.id"), default=None
    )
    error: Mapped[str | None] = mapped_column(Text, default=None)


class ProviderBindingStatus(enum.StrEnum):
    ACTIVE = "active"
    DISABLED = "disabled"
    INVALID = "invalid"


class ProviderBinding(TimestampMixin, Base):
    """Tenant-owned capture-provider configuration.

    Credentials and arbitrary endpoint URLs remain in the secret store. The
    database contains only reviewed references and the provider account scope
    used to prevent two tenants from claiming the same upstream account.
    """

    __tablename__ = "provider_binding"
    __table_args__ = (
        UniqueConstraint("provider", "account_scope_id", name="uq_provider_account_scope"),
        Index("ix_providerbinding_org_status", "org_id", "status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    provider: Mapped[str] = mapped_column(String(32))
    endpoint_ref: Mapped[str] = mapped_column(String(255))
    account_scope_id: Mapped[str] = mapped_column(String(255))
    secret_ref: Mapped[str] = mapped_column(String(255))
    status: Mapped[ProviderBindingStatus] = mapped_column(
        Enum(ProviderBindingStatus, native_enum=False, length=16),
        default=ProviderBindingStatus.ACTIVE,
    )


class CaptureRequestStatus(enum.StrEnum):
    QUEUED = "queued"
    DISPATCHING = "dispatching"
    ACCEPTED = "accepted"
    MONITORING = "monitoring"
    DISPATCH_UNKNOWN = "dispatch_unknown"
    RECONCILIATION_REQUIRED = "reconciliation_required"
    FINALIZED = "finalized"
    CANCELLED = "cancelled"
    FAILED = "failed"


class CaptureStopState(enum.StrEnum):
    NOT_REQUESTED = "not_requested"
    REQUESTED = "requested"
    ACKNOWLEDGED = "acknowledged"
    CONFIRMED = "confirmed"
    FAILED = "failed"


class CaptureRequest(TimestampMixin, Base):
    """Durable intent to capture one meeting occurrence.

    The invitation URL is stored through ``meeting_url_secret_ref`` only. The
    idempotency hash contains a one-way URL digest, never the URL or passcode.
    """

    __tablename__ = "capture_request"
    __table_args__ = (
        UniqueConstraint("org_id", "idempotency_key", name="uq_capture_request_org_key"),
        Index("ix_capture_request_org_status", "org_id", "status"),
        Index("ix_capture_request_meeting", "meeting_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    meeting_id: Mapped[str] = mapped_column(ForeignKey("meeting.id"))
    requested_by: Mapped[str] = mapped_column(ForeignKey("app_user.id"))
    platform: Mapped[str] = mapped_column(String(32))
    native_meeting_id: Mapped[str] = mapped_column(String(255))
    meeting_url_secret_ref: Mapped[str] = mapped_column(String(255))
    policy_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    input_hash: Mapped[str] = mapped_column(String(64))
    idempotency_key: Mapped[str] = mapped_column(String(255))
    status: Mapped[CaptureRequestStatus] = mapped_column(
        Enum(CaptureRequestStatus, native_enum=False, length=32),
        default=CaptureRequestStatus.QUEUED,
    )
    stop_state: Mapped[CaptureStopState] = mapped_column(
        Enum(CaptureStopState, native_enum=False, length=24),
        default=CaptureStopState.NOT_REQUESTED,
    )
    version: Mapped[int] = mapped_column(Integer, default=1)
    # Set once the provider transcript has been ingested into the pipeline.
    capture_session_id: Mapped[str | None] = mapped_column(
        ForeignKey("capture_session.id"), default=None
    )


class CaptureAttemptState(enum.StrEnum):
    SCHEDULED = "scheduled"
    JOINING = "joining"
    WAITING_FOR_ADMISSION = "waiting_for_admission"
    BLOCKED = "blocked"
    CAPTURING = "capturing"
    STOPPING = "stopping"
    ENDED = "ended"
    FAILED = "failed"
    UNKNOWN = "unknown"


class CaptureAttempt(TimestampMixin, Base):
    __tablename__ = "capture_attempt"
    __table_args__ = (
        UniqueConstraint("request_id", "attempt_no", name="uq_capture_attempt_number"),
        UniqueConstraint(
            "provider_binding_id", "provider_record_id", name="uq_capture_attempt_provider_record"
        ),
        Index("ix_capture_attempt_org_state", "org_id", "state"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    request_id: Mapped[str] = mapped_column(ForeignKey("capture_request.id"))
    attempt_no: Mapped[int] = mapped_column(Integer)
    provider_binding_id: Mapped[str] = mapped_column(ForeignKey("provider_binding.id"))
    provider_record_id: Mapped[str | None] = mapped_column(String(255), default=None)
    state: Mapped[CaptureAttemptState] = mapped_column(
        Enum(CaptureAttemptState, native_enum=False, length=32),
        default=CaptureAttemptState.SCHEDULED,
    )
    provider_status: Mapped[str | None] = mapped_column(String(64), default=None)
    error_code: Mapped[str | None] = mapped_column(String(128), default=None)
    fencing_version: Mapped[int] = mapped_column(Integer, default=0)
    last_provider_contact_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )
    state_entered_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )
    last_transcript_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )


class UsageReservationStatus(enum.StrEnum):
    RESERVED = "reserved"
    RELEASED = "released"
    RECONCILED = "reconciled"
    EXPIRED = "expired"


class UsageReservation(TimestampMixin, Base):
    __tablename__ = "usage_reservation"
    __table_args__ = (
        UniqueConstraint("request_id", "unit", name="uq_usage_reservation_request_unit"),
        Index("ix_usage_reservation_org_status", "org_id", "status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    request_id: Mapped[str] = mapped_column(ForeignKey("capture_request.id"))
    unit: Mapped[str] = mapped_column(String(32))
    estimated_quantity: Mapped[Decimal] = mapped_column(Numeric(14, 3))
    actual_quantity: Mapped[Decimal | None] = mapped_column(Numeric(14, 3), default=None)
    status: Mapped[UsageReservationStatus] = mapped_column(
        Enum(UsageReservationStatus, native_enum=False, length=16),
        default=UsageReservationStatus.RESERVED,
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class OutboxStatus(enum.StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


class OutboxEvent(TimestampMixin, Base):
    __tablename__ = "outbox_event"
    __table_args__ = (
        UniqueConstraint(
            "operation", "entity_id", "input_revision", name="uq_outbox_operation_revision"
        ),
        Index("ix_outbox_status_runat", "status", "run_at"),
        Index("ix_outbox_org", "org_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    operation: Mapped[str] = mapped_column(String(64))
    entity_id: Mapped[str] = mapped_column(String(36))
    input_revision: Mapped[str] = mapped_column(String(64))
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    status: Mapped[OutboxStatus] = mapped_column(
        Enum(OutboxStatus, native_enum=False, length=16), default=OutboxStatus.PENDING
    )
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=8)
    run_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    locked_by: Mapped[str | None] = mapped_column(String(64), default=None)
    locked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    fencing_version: Mapped[int] = mapped_column(Integer, default=0)
    error_code: Mapped[str | None] = mapped_column(String(128), default=None)


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
# Speaker separation & identity (docs/08-speaker-identity.md)
# --------------------------------------------------------------------------- #


class SpeakerTurn(TimestampMixin, Base):
    """One diarized span of speech by one (still anonymous) voice.

    Written by the `diarize` stage for mixed-audio sessions only — Zoom
    per-participant tracks already carry exact identity and skip diarization
    entirely (app/interfaces/diarizer.py). `cluster_id` is session-local and
    meaningless across sessions; `SessionSpeaker` is where it becomes a
    person."""

    __tablename__ = "speaker_turn"
    __table_args__ = (Index("ix_speakerturn_session_start", "capture_session_id", "start_s"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    capture_session_id: Mapped[str] = mapped_column(ForeignKey("capture_session.id"))
    audio_track_id: Mapped[str | None] = mapped_column(ForeignKey("audio_track.id"), default=None)
    start_s: Mapped[float] = mapped_column(Float)
    end_s: Mapped[float] = mapped_column(Float)
    cluster_id: Mapped[str] = mapped_column(String(64))  # e.g. "SPEAKER_00"
    confidence: Mapped[float] = mapped_column(Float, default=1.0)


class SpeakerResolution(enum.StrEnum):
    """How a cluster got its person_id — surfaced so a report can state *how*
    it knows who spoke, not just assert a name."""

    ROSTER = "roster"  # platform-supplied speaker labels (Meet/Teams)
    VOICEPRINT = "voiceprint"  # matched a known Person's enrolled voice
    MANUAL = "manual"  # a human corrected it
    UNRESOLVED = "unresolved"  # honestly unknown — never guess a name


class SessionSpeaker(TimestampMixin, Base):
    """One row per distinct voice in a session — where anonymous diarization
    clusters become real people.

    Split from `SpeakerTurn` so identity is resolved once per voice rather
    than once per turn. The voiceprint embedding that carries identity across
    meetings lands here in Phase B (docs/08-speaker-identity.md), once the
    pyannote embedding dimensionality is verified against the real model
    rather than assumed."""

    __tablename__ = "session_speaker"
    __table_args__ = (
        Index("ix_sessionspeaker_session", "capture_session_id"),
        Index(
            "ix_sessionspeaker_embedding_hnsw",
            "embedding",
            postgresql_using="hnsw",
            postgresql_ops={"embedding": "vector_cosine_ops"},
        ).ddl_if(dialect="postgresql"),
        UniqueConstraint(
            "capture_session_id",
            "audio_track_id",
            "cluster_id",
            name="uq_session_speaker_track_cluster",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    capture_session_id: Mapped[str] = mapped_column(ForeignKey("capture_session.id"))
    audio_track_id: Mapped[str | None] = mapped_column(ForeignKey("audio_track.id"), default=None)
    cluster_id: Mapped[str] = mapped_column(String(64))
    person_id: Mapped[str | None] = mapped_column(ForeignKey("person.id"), default=None)
    resolution_method: Mapped[SpeakerResolution] = mapped_column(
        Enum(SpeakerResolution, native_enum=False, length=16),
        default=SpeakerResolution.UNRESOLVED,
    )
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
    # This cluster's centroid voice embedding for the session. Kept even when
    # the speaker stays unresolved: a later manual correction can enroll it
    # against a Person retroactively, and re-running identity fusion after
    # more people are known never needs the audio again.
    embedding: Mapped[list[float] | None] = mapped_column(Vector(512), nullable=True)


class PlatformSpeakerLabel(TimestampMixin, Base):
    """Platform transcript speaker-name spans retained for roster fusion.

    Meet/Teams can provide useful labels even when their transcript text is
    not trusted for code-switching. These rows keep only the timing/name
    signal needed to map diarized clusters to People.
    """

    __tablename__ = "platform_speaker_label"
    __table_args__ = (Index("ix_platformlabel_session_start", "capture_session_id", "start_s"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    capture_session_id: Mapped[str] = mapped_column(ForeignKey("capture_session.id"))
    start_s: Mapped[float] = mapped_column(Float)
    end_s: Mapped[float] = mapped_column(Float)
    display_name: Mapped[str] = mapped_column(String(255))
    provider: Mapped[str] = mapped_column(String(64), default="")


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
    lang_tags: Mapped[list[Any]] = mapped_column(JSON, default=list)  # ["si","en"] per plan
    asr_confidence: Mapped[float] = mapped_column(Float, default=1.0)
    # Which diarized voice said this, when known. Distinct from person_id:
    # a cluster separates speakers without naming them, so a transcript can
    # show "Speaker 1 / Speaker 2" before identity fusion resolves who they
    # actually are (docs/08-speaker-identity.md).
    speaker_cluster_id: Mapped[str | None] = mapped_column(String(64), default=None)
    # Confidence that `person_id` is correct -- 0.0 whenever the person is
    # unknown, even if the cluster assignment itself was clean.
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
    detected_entities: Mapped[list[Any]] = mapped_column(JSON, default=list)  # ticket IDs, URLs…


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
        Index("ix_ki_org_owner_state", "org_id", "owner_person_id", "lifecycle_state"),
        Index("ix_ki_session", "capture_session_id"),
        # ANN index for the hybrid-search vector leg (app/api/chat.py,
        # app/agents/memory.py both ORDER BY embedding.cosine_distance).
        # Without it every semantic query is a sequential scan over the
        # org's whole knowledge base. `ddl_if` keeps it Postgres-only so the
        # SQLite test metadata stays creatable.
        Index(
            "ix_ki_embedding_hnsw",
            "embedding",
            postgresql_using="hnsw",
            postgresql_ops={"embedding": "vector_cosine_ops"},
        ).ddl_if(dialect="postgresql"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    capture_session_id: Mapped[str] = mapped_column(ForeignKey("capture_session.id"))
    type: Mapped[KnowledgeType] = mapped_column(Enum(KnowledgeType, native_enum=False, length=16))
    statement: Mapped[str] = mapped_column(Text)
    owner_person_id: Mapped[str | None] = mapped_column(ForeignKey("person.id"), default=None)
    owner_candidate_person_id: Mapped[str | None] = mapped_column(
        ForeignKey("person.id"), default=None
    )
    owner_utterance_id: Mapped[str | None] = mapped_column(ForeignKey("utterance.id"), default=None)
    owner_source: Mapped[str | None] = mapped_column(String(32), default=None)
    owner_attribution_confidence: Mapped[float | None] = mapped_column(Float, default=None)
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
    BLOCKS = "blocks"


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
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)
    status: Mapped[ActionStatus] = mapped_column(
        Enum(ActionStatus, native_enum=False, length=24), default=ActionStatus.PENDING_APPROVAL
    )
    approved_by_person_id: Mapped[str | None] = mapped_column(ForeignKey("person.id"), default=None)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    executed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    external_id: Mapped[str | None] = mapped_column(String(255), default=None)
    external_url: Mapped[str | None] = mapped_column(String(1000), default=None)
    error: Mapped[str | None] = mapped_column(Text, default=None)


class WorkStatus(enum.StrEnum):
    OPEN = "open"
    CLOSED = "closed"
    UNKNOWN = "unknown"


class WorkEvidence(TimestampMixin, Base):
    """Snapshot of an external tracker check for an executed action.

    The snapshot is not itself lifecycle state; when it proves closure the
    work-tracking sweep writes a normal KnowledgeEdge.RESOLVES so lifecycle
    derivation stays one rule over evidence-backed edges.
    """

    __tablename__ = "work_evidence"
    __table_args__ = (
        Index("ix_workevidence_action", "action_id"),
        Index("ix_workevidence_item", "knowledge_item_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    action_id: Mapped[str] = mapped_column(ForeignKey("proposed_action.id"))
    knowledge_item_id: Mapped[str] = mapped_column(ForeignKey("knowledge_item.id"))
    provider: Mapped[str] = mapped_column(String(32))
    external_id: Mapped[str] = mapped_column(String(255))
    status: Mapped[WorkStatus] = mapped_column(
        Enum(WorkStatus, native_enum=False, length=16), default=WorkStatus.UNKNOWN
    )
    status_label: Mapped[str] = mapped_column(String(255), default="")
    external_url: Mapped[str | None] = mapped_column(String(1000), default=None)
    raw: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


# --------------------------------------------------------------------------- #
# Person-scoped longitudinal intelligence
# --------------------------------------------------------------------------- #


class LongitudinalState(enum.StrEnum):
    ASSEMBLING = "assembling"
    DETECTING = "detecting"
    ASSESSING = "assessing"
    AUDITING = "auditing"
    NARRATING = "narrating"
    RECOMMENDING = "recommending"
    DONE = "done"
    FAILED = "failed"


class FindingKind(enum.StrEnum):
    DECISION_TRAJECTORY = "decision_trajectory"
    REPETITION = "repetition"
    PROGRESS = "progress"


class FindingAuditStatus(enum.StrEnum):
    PENDING = "pending"
    SUPPORTED = "supported"
    PARTIALLY_SUPPORTED = "partially_supported"
    UNSUPPORTED = "unsupported"


class PersonAnalysisRun(TimestampMixin, Base):
    """Idempotent person-scoped analysis run for a fixed period/evidence set."""

    __tablename__ = "person_analysis_run"
    __table_args__ = (
        UniqueConstraint(
            "person_id", "period_start", "period_end", name="uq_person_analysis_period"
        ),
        Index("ix_person_analysis_org_state", "org_id", "state"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    person_id: Mapped[str] = mapped_column(ForeignKey("person.id"))
    period_start: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    period_end: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    evidence_hash: Mapped[str] = mapped_column(String(64))
    last_evidence_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    state: Mapped[LongitudinalState] = mapped_column(
        Enum(LongitudinalState, native_enum=False, length=24),
        default=LongitudinalState.ASSEMBLING,
    )
    summary: Mapped[str] = mapped_column(Text, default="")
    coverage_disclosure: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    prompt_versions: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    error: Mapped[str | None] = mapped_column(Text, default=None)


class LongitudinalFinding(TimestampMixin, Base):
    """Evidence-bound claim emitted by a person-level agent and blind-audited."""

    __tablename__ = "longitudinal_finding"
    __table_args__ = (
        Index("ix_longitudinal_finding_run", "analysis_run_id"),
        Index("ix_longitudinal_finding_org_person", "org_id", "person_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    person_id: Mapped[str] = mapped_column(ForeignKey("person.id"))
    analysis_run_id: Mapped[str] = mapped_column(ForeignKey("person_analysis_run.id"))
    kind: Mapped[FindingKind] = mapped_column(
        Enum(FindingKind, native_enum=False, length=24)
    )
    statement: Mapped[str] = mapped_column(Text)
    confidence: Mapped[Confidence] = mapped_column(
        Enum(Confidence, native_enum=False, length=24), default=Confidence.AMBIGUOUS
    )
    evidence_item_ids: Mapped[list[Any]] = mapped_column(JSON, default=list)
    sample_size: Mapped[int] = mapped_column(Integer, default=0)
    finding_metadata: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    audit_status: Mapped[FindingAuditStatus] = mapped_column(
        Enum(FindingAuditStatus, native_enum=False, length=24),
        default=FindingAuditStatus.PENDING,
    )
    audit_rationale: Mapped[str] = mapped_column(Text, default="")
    prompt_version: Mapped[str] = mapped_column(String(64), default="")


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
    source_correction_id: Mapped[str | None] = mapped_column(
        ForeignKey("correction.id"), default=None
    )


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
    detail: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


# --------------------------------------------------------------------------- #
# Pipeline job queue (Postgres-backed FSM; FOR UPDATE SKIP LOCKED)
# --------------------------------------------------------------------------- #


class JobStatus(enum.StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


class WorkerSweepState(TimestampMixin, Base):
    """Durable last-run timestamp for each periodic worker sweep (calendar
    sync, retention, lifecycle, etc.), keyed by sweep name.

    Exists because the worker no longer runs as an always-on process: it
    scales to zero between Cloud Scheduler-triggered invocations to avoid
    paying for idle compute (see .github/workflows/deploy.yml and
    app/orchestrator/worker.py's `run_bounded_pass`). An in-memory `last_run`
    variable -- the previous approach -- resets to nothing on every cold
    start, which would make every sweep fire on every single invocation
    regardless of its configured interval. This table is what lets a sweep
    still mean "at most every N seconds" across restarts."""

    __tablename__ = "worker_sweep_state"

    name: Mapped[str] = mapped_column(String(64), primary_key=True)
    last_run_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class PipelineJob(TimestampMixin, Base):
    __tablename__ = "pipeline_job"
    __table_args__ = (Index("ix_job_status_runat", "status", "run_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    capture_session_id: Mapped[str] = mapped_column(ForeignKey("capture_session.id"))
    stage: Mapped[str] = mapped_column(
        String(32)
    )  # acquire|diarize|identify|transcribe|understand|verify|remember|propose|report
    status: Mapped[JobStatus] = mapped_column(
        Enum(JobStatus, native_enum=False, length=16), default=JobStatus.QUEUED
    )
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=5)
    run_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    locked_by: Mapped[str | None] = mapped_column(String(64), default=None)
    locked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    error: Mapped[str | None] = mapped_column(Text, default=None)


class LlmCall(TimestampMixin, Base):
    """One row per LlmClient call — the cost-attribution ledger.

    Written by app/orchestrator/llm_accounting.py's RecordingLlmClient in its
    own committed transaction, deliberately independent of the stage that
    made the call: tokens spent on an attempt that later rolled back are
    still tokens spent, and under-reporting exactly when a job is failing and
    retrying would hide the most expensive failure mode there is.

    `ok=False` rows are kept for the same reason — a call that errored after
    the model generated output still costs money, and a burst of failed calls
    is itself the signal worth alarming on.
    """

    __tablename__ = "llm_call"
    __table_args__ = (
        Index("ix_llmcall_org_at", "org_id", "at"),
        Index("ix_llmcall_session", "capture_session_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    # Nullable: not every call belongs to a capture session (org-memory chat
    # answers a question that spans many meetings, or none).
    capture_session_id: Mapped[str | None] = mapped_column(
        ForeignKey("capture_session.id"), default=None
    )
    stage: Mapped[str] = mapped_column(String(32), default="")
    model: Mapped[str] = mapped_column(String(64), default="")
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    ok: Mapped[bool] = mapped_column(Boolean, default=True)
    error: Mapped[str | None] = mapped_column(Text, default=None)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


# ---------------------------------------------------------------------------
# Landing-page lead capture (public, unauthenticated -- app/api/leads.py)
# ---------------------------------------------------------------------------

class LeadKind(enum.StrEnum):
    DEMO = "demo"
    COLLABORATE = "collaborate"


class LandingLead(TimestampMixin, Base):
    """Submission from the /welcome page "Book a demo" or "Collaborate with us" form."""

    __tablename__ = "landing_lead"
    __table_args__ = (Index("ix_landing_lead_kind_created", "kind", "created_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    kind: Mapped[str] = mapped_column(
        Enum(LeadKind, native_enum=False, length=16), nullable=False
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    email: Mapped[str] = mapped_column(String(255), nullable=False)
    company: Mapped[str | None] = mapped_column(String(255), nullable=True)
    message: Mapped[str | None] = mapped_column(Text, nullable=True)


class MediaRefKind(enum.StrEnum):
    AUDIO_CHUNK = "audio_chunk"
    FULL_AUDIO = "full_audio"
    PROVIDER_RECORDING = "provider_recording"


class MediaDeletionState(enum.StrEnum):
    PENDING = "pending"
    DELETED = "deleted"
    FAILED = "failed"


class CaptureMediaRef(TimestampMixin, Base):
    """Tracks a temporary media artifact that must be deleted within a hard deadline.

    Audio recording is disabled until the full deletion lifecycle is verified.
    No artifact should outlive its delete_after timestamp under any failure mode.
    """

    __tablename__ = "capture_media_ref"
    __table_args__ = (
        Index("ix_capture_media_ref_pending", "state", "delete_after"),
        Index("ix_capture_media_ref_request", "request_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    request_id: Mapped[str] = mapped_column(ForeignKey("capture_request.id"))
    kind: Mapped[MediaRefKind] = mapped_column(
        Enum(MediaRefKind, native_enum=False, length=24),
    )
    store_ref: Mapped[str] = mapped_column(String(1024))
    delete_after: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    state: Mapped[MediaDeletionState] = mapped_column(
        Enum(MediaDeletionState, native_enum=False, length=16),
        default=MediaDeletionState.PENDING,
    )
    delete_attempts: Mapped[int] = mapped_column(Integer, default=0)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    overdue: Mapped[bool] = mapped_column(Boolean, default=False)


# --------------------------------------------------------------------------- #
# F09 — Versioned project/customer memory
# --------------------------------------------------------------------------- #


class SummaryState(enum.StrEnum):
    PENDING = "pending"
    READY = "ready"
    PARTIAL = "partial"
    FAILED = "failed"


class SummaryVersion(TimestampMixin, Base):
    """Incrementally maintained summary for a project or customer scope.

    One row per (scope_kind, scope_id, input_revision_hash) triple.  The latest
    READY row is the authoritative memory for that scope; older rows are kept for
    audit and rollback.  scope_kind is "project" or "customer".

    structured_summary carries the JSON payload (decisions, commitments,
    open_questions, context_summary); it must not contain raw transcript text —
    only verified claims with source_meeting_ids references.
    """

    __tablename__ = "summary_version"
    __table_args__ = (
        CheckConstraint("scope_kind IN ('project', 'customer')", name="ck_sv_scope_kind"),
        Index("ix_sv_scope_state", "scope_kind", "scope_id", "state"),
        Index("ix_sv_org_scope", "org_id", "scope_kind", "scope_id"),
        UniqueConstraint("scope_kind", "scope_id", "input_revision_hash", name="uq_sv_scope_revision"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    scope_kind: Mapped[str] = mapped_column(String(16))
    scope_id: Mapped[str] = mapped_column(String(36))
    input_revision_hash: Mapped[str] = mapped_column(String(64))
    state: Mapped[SummaryState] = mapped_column(
        Enum(SummaryState, native_enum=False, length=16),
        default=SummaryState.PENDING,
    )
    structured_summary: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    source_meeting_ids: Mapped[list[Any]] = mapped_column(JSON, default=list)
    error: Mapped[str | None] = mapped_column(Text, default=None)


# --------------------------------------------------------------------------- #
# F10 — Persistent project/customer conversations
# --------------------------------------------------------------------------- #


class ThreadStatus(enum.StrEnum):
    ACTIVE = "active"
    ARCHIVED = "archived"


class MessageRole(enum.StrEnum):
    USER = "user"
    ASSISTANT = "assistant"


class MessageState(enum.StrEnum):
    PENDING = "pending"
    GENERATING = "generating"
    DONE = "done"
    FAILED = "failed"


class ChatThread(TimestampMixin, Base):
    """Creator-private conversation thread scoped to a project or customer.

    scope_kind is "project" or "customer"; scope_id is the entity PK.
    Threads are private to their creator in the pilot; sharing is deferred.
    """

    __tablename__ = "chat_thread"
    __table_args__ = (
        CheckConstraint("scope_kind IN ('project', 'customer')", name="ck_ct_scope_kind"),
        Index("ix_ct_org_creator_scope", "org_id", "creator_id", "scope_kind", "scope_id"),
        Index("ix_ct_scope", "scope_kind", "scope_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    scope_kind: Mapped[str] = mapped_column(String(16))
    scope_id: Mapped[str] = mapped_column(String(36))
    creator_id: Mapped[str] = mapped_column(ForeignKey("app_user.id"))
    title: Mapped[str] = mapped_column(String(255), default="")
    status: Mapped[ThreadStatus] = mapped_column(
        Enum(ThreadStatus, native_enum=False, length=16),
        default=ThreadStatus.ACTIVE,
    )
    version: Mapped[int] = mapped_column(Integer, default=1)


class ChatMessage(TimestampMixin, Base):
    """One message in a ChatThread.

    client_request_id enables idempotent user sends (same UUID → same row).
    assistant messages gain a generation_id for SSE streaming.
    """

    __tablename__ = "chat_message"
    __table_args__ = (
        Index("ix_cm_thread", "thread_id"),
        UniqueConstraint("thread_id", "client_request_id", name="uq_cm_thread_client_req"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    thread_id: Mapped[str] = mapped_column(ForeignKey("chat_thread.id"))
    role: Mapped[MessageRole] = mapped_column(
        Enum(MessageRole, native_enum=False, length=16),
    )
    state: Mapped[MessageState] = mapped_column(
        Enum(MessageState, native_enum=False, length=16),
        default=MessageState.DONE,
    )
    content: Mapped[str] = mapped_column(Text, default="")
    client_request_id: Mapped[str | None] = mapped_column(String(36), default=None)
    generation_id: Mapped[str | None] = mapped_column(String(36), default=None)


class AnswerCitation(Base):
    """Source link from an assistant message to a meeting segment.

    Read-only — never updated after creation.  Only returned to callers who
    can access the referenced meeting (checked at read time, not stored here).
    """

    __tablename__ = "answer_citation"
    __table_args__ = (
        Index("ix_ac_message", "message_id"),
        Index("ix_ac_meeting", "meeting_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(ForeignKey("org.id"))
    message_id: Mapped[str] = mapped_column(ForeignKey("chat_message.id"))
    meeting_id: Mapped[str] = mapped_column(ForeignKey("meeting.id"))
    knowledge_item_id: Mapped[str | None] = mapped_column(ForeignKey("knowledge_item.id"), default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
