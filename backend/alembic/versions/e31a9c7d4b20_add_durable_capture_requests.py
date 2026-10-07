"""add durable capture requests

Revision ID: e31a9c7d4b20
Revises: f8e2c4a6b1d3
Create Date: 2026-10-07 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "e31a9c7d4b20"
down_revision: str | None = "f8e2c4a6b1d3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "provider_binding",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("org_id", sa.String(length=36), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("endpoint_ref", sa.String(length=255), nullable=False),
        sa.Column("account_scope_id", sa.String(length=255), nullable=False),
        sa.Column("secret_ref", sa.String(length=255), nullable=False),
        sa.Column(
            "status",
            sa.Enum("ACTIVE", "DISABLED", "INVALID", native_enum=False, length=16),
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["org.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("provider", "account_scope_id", name="uq_provider_account_scope"),
    )
    op.create_index(
        "ix_providerbinding_org_status", "provider_binding", ["org_id", "status"]
    )

    op.create_table(
        "capture_request",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("org_id", sa.String(length=36), nullable=False),
        sa.Column("meeting_id", sa.String(length=36), nullable=False),
        sa.Column("requested_by", sa.String(length=36), nullable=False),
        sa.Column("platform", sa.String(length=32), nullable=False),
        sa.Column("native_meeting_id", sa.String(length=255), nullable=False),
        sa.Column("meeting_url_secret_ref", sa.String(length=255), nullable=False),
        sa.Column("policy_snapshot", sa.JSON(), nullable=False),
        sa.Column("input_hash", sa.String(length=64), nullable=False),
        sa.Column("idempotency_key", sa.String(length=255), nullable=False),
        sa.Column(
            "status",
            sa.Enum(
                "QUEUED",
                "DISPATCHING",
                "ACCEPTED",
                "MONITORING",
                "DISPATCH_UNKNOWN",
                "RECONCILIATION_REQUIRED",
                "FINALIZED",
                "CANCELLED",
                "FAILED",
                native_enum=False,
                length=32,
            ),
            nullable=False,
        ),
        sa.Column(
            "stop_state",
            sa.Enum(
                "NOT_REQUESTED",
                "REQUESTED",
                "ACKNOWLEDGED",
                "CONFIRMED",
                "FAILED",
                native_enum=False,
                length=24,
            ),
            nullable=False,
        ),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["meeting_id"], ["meeting.id"]),
        sa.ForeignKeyConstraint(["org_id"], ["org.id"]),
        sa.ForeignKeyConstraint(["requested_by"], ["app_user.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("org_id", "idempotency_key", name="uq_capture_request_org_key"),
    )
    op.create_index("ix_capture_request_meeting", "capture_request", ["meeting_id"])
    op.create_index(
        "ix_capture_request_org_status", "capture_request", ["org_id", "status"]
    )

    op.create_table(
        "capture_attempt",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("org_id", sa.String(length=36), nullable=False),
        sa.Column("request_id", sa.String(length=36), nullable=False),
        sa.Column("attempt_no", sa.Integer(), nullable=False),
        sa.Column("provider_binding_id", sa.String(length=36), nullable=False),
        sa.Column("provider_record_id", sa.String(length=255), nullable=True),
        sa.Column(
            "state",
            sa.Enum(
                "SCHEDULED",
                "JOINING",
                "WAITING_FOR_ADMISSION",
                "BLOCKED",
                "CAPTURING",
                "STOPPING",
                "ENDED",
                "FAILED",
                "UNKNOWN",
                native_enum=False,
                length=32,
            ),
            nullable=False,
        ),
        sa.Column("provider_status", sa.String(length=64), nullable=True),
        sa.Column("error_code", sa.String(length=128), nullable=True),
        sa.Column("fencing_version", sa.Integer(), nullable=False),
        sa.Column("last_provider_contact_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["org.id"]),
        sa.ForeignKeyConstraint(["provider_binding_id"], ["provider_binding.id"]),
        sa.ForeignKeyConstraint(["request_id"], ["capture_request.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("request_id", "attempt_no", name="uq_capture_attempt_number"),
        sa.UniqueConstraint(
            "provider_binding_id",
            "provider_record_id",
            name="uq_capture_attempt_provider_record",
        ),
    )
    op.create_index(
        "ix_capture_attempt_org_state", "capture_attempt", ["org_id", "state"]
    )

    op.create_table(
        "usage_reservation",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("org_id", sa.String(length=36), nullable=False),
        sa.Column("request_id", sa.String(length=36), nullable=False),
        sa.Column("unit", sa.String(length=32), nullable=False),
        sa.Column("estimated_quantity", sa.Numeric(precision=14, scale=3), nullable=False),
        sa.Column("actual_quantity", sa.Numeric(precision=14, scale=3), nullable=True),
        sa.Column(
            "status",
            sa.Enum("RESERVED", "RELEASED", "RECONCILED", "EXPIRED", native_enum=False, length=16),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["org.id"]),
        sa.ForeignKeyConstraint(["request_id"], ["capture_request.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("request_id", "unit", name="uq_usage_reservation_request_unit"),
    )
    op.create_index(
        "ix_usage_reservation_org_status", "usage_reservation", ["org_id", "status"]
    )

    op.create_table(
        "outbox_event",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("org_id", sa.String(length=36), nullable=False),
        sa.Column("operation", sa.String(length=64), nullable=False),
        sa.Column("entity_id", sa.String(length=36), nullable=False),
        sa.Column("input_revision", sa.String(length=64), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column(
            "status",
            sa.Enum("PENDING", "RUNNING", "DONE", "FAILED", native_enum=False, length=16),
            nullable=False,
        ),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("max_attempts", sa.Integer(), nullable=False),
        sa.Column("run_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("locked_by", sa.String(length=64), nullable=True),
        sa.Column("locked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("fencing_version", sa.Integer(), nullable=False),
        sa.Column("error_code", sa.String(length=128), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["org.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "operation", "entity_id", "input_revision", name="uq_outbox_operation_revision"
        ),
    )
    op.create_index("ix_outbox_org", "outbox_event", ["org_id"])
    op.create_index("ix_outbox_status_runat", "outbox_event", ["status", "run_at"])


def downgrade() -> None:
    op.drop_index("ix_outbox_status_runat", table_name="outbox_event")
    op.drop_index("ix_outbox_org", table_name="outbox_event")
    op.drop_table("outbox_event")
    op.drop_index("ix_usage_reservation_org_status", table_name="usage_reservation")
    op.drop_table("usage_reservation")
    op.drop_index("ix_capture_attempt_org_state", table_name="capture_attempt")
    op.drop_table("capture_attempt")
    op.drop_index("ix_capture_request_org_status", table_name="capture_request")
    op.drop_index("ix_capture_request_meeting", table_name="capture_request")
    op.drop_table("capture_request")
    op.drop_index("ix_providerbinding_org_status", table_name="provider_binding")
    op.drop_table("provider_binding")
