"""Add capture_session_id link to capture_request.

Revision ID: f7b8c9d0e1a2
Revises: e5f6a7b8c9d0
Create Date: 2026-10-08

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f7b8c9d0e1a2"
down_revision: str | None = "e5f6a7b8c9d0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "capture_request",
        sa.Column(
            "capture_session_id",
            sa.String(36),
            sa.ForeignKey("capture_session.id"),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_capture_request_session",
        "capture_request",
        ["capture_session_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_capture_request_session", table_name="capture_request")
    op.drop_column("capture_request", "capture_session_id")
