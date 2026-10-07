"""Add pilot_features_enabled to org for F14.

Revision ID: g8a9b0c1d2e3
Revises: f7a8b9c0d1e2
Create Date: 2026-10-08

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "g8a9b0c1d2e3"
down_revision: str | None = "f7a8b9c0d1e2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "org",
        sa.Column("pilot_features_enabled", sa.Boolean, nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("org", "pilot_features_enabled")
