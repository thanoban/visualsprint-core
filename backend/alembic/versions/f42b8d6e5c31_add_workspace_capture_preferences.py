"""add workspace capture preferences

Revision ID: f42b8d6e5c31
Revises: e31a9c7d4b20
Create Date: 2026-10-08 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "f42b8d6e5c31"
down_revision: str | None = "e31a9c7d4b20"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("org", sa.Column("timezone", sa.String(length=64), nullable=True))
    op.add_column("org", sa.Column("preferred_language", sa.String(length=16), nullable=True))
    op.add_column("org", sa.Column("capture_policy", sa.String(length=32), nullable=True))
    op.add_column("org", sa.Column("capture_concurrency_limit", sa.Integer(), nullable=True))
    op.add_column("org", sa.Column("capture_monthly_minutes", sa.Integer(), nullable=True))
    op.add_column("org", sa.Column("disclosure_ack_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("org", sa.Column("disclosure_ack_by", sa.String(length=36), nullable=True))
    op.create_foreign_key(
        "fk_org_disclosure_ack_by_user", "org", "app_user", ["disclosure_ack_by"], ["id"]
    )
    op.execute(
        "UPDATE org SET timezone='UTC', preferred_language='en', capture_policy='off', "
        "capture_concurrency_limit=5, capture_monthly_minutes=6000"
    )
    op.alter_column("org", "timezone", nullable=False)
    op.alter_column("org", "preferred_language", nullable=False)
    op.alter_column("org", "capture_policy", nullable=False)
    op.alter_column("org", "capture_concurrency_limit", nullable=False)
    op.alter_column("org", "capture_monthly_minutes", nullable=False)


def downgrade() -> None:
    op.drop_constraint("fk_org_disclosure_ack_by_user", "org", type_="foreignkey")
    op.drop_column("org", "disclosure_ack_by")
    op.drop_column("org", "disclosure_ack_at")
    op.drop_column("org", "capture_monthly_minutes")
    op.drop_column("org", "capture_concurrency_limit")
    op.drop_column("org", "capture_policy")
    op.drop_column("org", "preferred_language")
    op.drop_column("org", "timezone")
