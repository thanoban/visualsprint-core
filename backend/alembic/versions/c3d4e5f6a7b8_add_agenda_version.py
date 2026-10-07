"""Add agenda_version table for F11 next-meeting agenda.

Revision ID: c3d4e5f6a7b8
Revises: b2c3d4e5f6a7
Create Date: 2026-10-08

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c3d4e5f6a7b8"
down_revision: str | None = "b2c3d4e5f6a7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "agenda_version",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("org_id", sa.String(36), sa.ForeignKey("org.id"), nullable=False),
        sa.Column(
            "occurrence_id",
            sa.String(36),
            sa.ForeignKey("calendar_occurrence.id"),
            nullable=False,
        ),
        sa.Column("input_revision_hash", sa.String(64), nullable=False),
        sa.Column("sections", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("edited_by", sa.String(36), sa.ForeignKey("app_user.id"), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("objective", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.UniqueConstraint(
            "occurrence_id", "input_revision_hash", name="uq_av_occurrence_revision"
        ),
    )
    op.create_index("ix_av_occurrence", "agenda_version", ["occurrence_id"])


def downgrade() -> None:
    op.drop_index("ix_av_occurrence", table_name="agenda_version")
    op.drop_table("agenda_version")
