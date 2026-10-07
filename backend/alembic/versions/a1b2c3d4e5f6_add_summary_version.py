"""Add summary_version table for F09 project/customer memory.

Revision ID: a1b2c3d4e5f6
Revises: f7b8c9d0e1a2
Create Date: 2026-10-08

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a1b2c3d4e5f6"
down_revision: str | None = "f7b8c9d0e1a2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "summary_version",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("org_id", sa.String(36), sa.ForeignKey("org.id"), nullable=False),
        sa.Column("scope_kind", sa.String(16), nullable=False),
        sa.Column("scope_id", sa.String(36), nullable=False),
        sa.Column("input_revision_hash", sa.String(64), nullable=False),
        sa.Column("state", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("structured_summary", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("source_meeting_ids", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("error", sa.Text(), nullable=True),
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
        sa.CheckConstraint("scope_kind IN ('project', 'customer')", name="ck_sv_scope_kind"),
        sa.UniqueConstraint(
            "scope_kind", "scope_id", "input_revision_hash", name="uq_sv_scope_revision"
        ),
    )
    op.create_index("ix_sv_scope_state", "summary_version", ["scope_kind", "scope_id", "state"])
    op.create_index("ix_sv_org_scope", "summary_version", ["org_id", "scope_kind", "scope_id"])


def downgrade() -> None:
    op.drop_index("ix_sv_org_scope", table_name="summary_version")
    op.drop_index("ix_sv_scope_state", table_name="summary_version")
    op.drop_table("summary_version")
