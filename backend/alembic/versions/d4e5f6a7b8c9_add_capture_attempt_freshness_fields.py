"""add state_entered_at and last_transcript_at to capture_attempt

Revision ID: d4e5f6a7b8c9
Revises: b7e2f1a3c9d5
Create Date: 2026-10-08

"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "d4e5f6a7b8c9"
down_revision = "b7e2f1a3c9d5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "capture_attempt",
        sa.Column("state_entered_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "capture_attempt",
        sa.Column("last_transcript_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("capture_attempt", "last_transcript_at")
    op.drop_column("capture_attempt", "state_entered_at")
