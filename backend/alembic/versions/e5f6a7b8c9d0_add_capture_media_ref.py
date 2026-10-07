"""add capture_media_ref table for temporary media deletion lifecycle

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-10-08

"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "e5f6a7b8c9d0"
down_revision = "d4e5f6a7b8c9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "capture_media_ref",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("org_id", sa.String(36), sa.ForeignKey("org.id"), nullable=False),
        sa.Column(
            "request_id", sa.String(36), sa.ForeignKey("capture_request.id"), nullable=False
        ),
        sa.Column("kind", sa.String(24), nullable=False),
        sa.Column("store_ref", sa.String(1024), nullable=False),
        sa.Column("delete_after", sa.DateTime(timezone=True), nullable=False),
        sa.Column("state", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("delete_attempts", sa.Integer, nullable=False, server_default="0"),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("overdue", sa.Boolean, nullable=False, server_default="false"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index(
        "ix_capture_media_ref_pending",
        "capture_media_ref",
        ["state", "delete_after"],
    )
    op.create_index(
        "ix_capture_media_ref_request",
        "capture_media_ref",
        ["request_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_capture_media_ref_request", table_name="capture_media_ref")
    op.drop_index("ix_capture_media_ref_pending", table_name="capture_media_ref")
    op.drop_table("capture_media_ref")
