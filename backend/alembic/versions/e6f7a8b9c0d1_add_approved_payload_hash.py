"""Add approved_payload_hash to proposed_action for F12.

Revision ID: e6f7a8b9c0d1
Revises: c3d4e5f6a7b8
Create Date: 2026-10-08

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e6f7a8b9c0d1"
down_revision: str | None = "c3d4e5f6a7b8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "proposed_action",
        sa.Column("approved_payload_hash", sa.String(64), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("proposed_action", "approved_payload_hash")
