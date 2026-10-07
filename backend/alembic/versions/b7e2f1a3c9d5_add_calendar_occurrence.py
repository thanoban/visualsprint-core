"""add calendar_occurrence table

Revision ID: b7e2f1a3c9d5
Revises: a53c9e7f6d42
Create Date: 2026-10-08 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "b7e2f1a3c9d5"
down_revision: str | None = "a53c9e7f6d42"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "calendar_occurrence",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("org_id", sa.String(length=36), nullable=False),
        sa.Column("connection_id", sa.String(length=36), nullable=False),
        sa.Column("provider_event_id", sa.String(length=255), nullable=False),
        sa.Column("original_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("start_time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("end_time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("title", sa.String(length=500), nullable=False, server_default=""),
        sa.Column("meeting_url", sa.String(length=2048), nullable=True),
        sa.Column("platform", sa.String(length=32), nullable=True),
        sa.Column("platform_meeting_id", sa.String(length=255), nullable=True),
        sa.Column(
            "status",
            sa.Enum("SCHEDULED", "CANCELLED", "ENDED", native_enum=False, length=16),
            nullable=False,
            server_default="SCHEDULED",
        ),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("capture_override", sa.String(length=8), nullable=True),
        sa.Column("meeting_id", sa.String(length=36), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["connection_id"], ["calendar_connection.id"]),
        sa.ForeignKeyConstraint(["meeting_id"], ["meeting.id"]),
        sa.ForeignKeyConstraint(["org_id"], ["org.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "connection_id", "provider_event_id",
            name="uq_occurrence_connection_event",
        ),
    )
    op.create_index("ix_occurrence_org_start", "calendar_occurrence", ["org_id", "start_time"])
    op.create_index("ix_occurrence_connection", "calendar_occurrence", ["connection_id"])


def downgrade() -> None:
    op.drop_index("ix_occurrence_connection", table_name="calendar_occurrence")
    op.drop_index("ix_occurrence_org_start", table_name="calendar_occurrence")
    op.drop_table("calendar_occurrence")
