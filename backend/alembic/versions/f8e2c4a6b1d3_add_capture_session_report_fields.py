"""add capture_session report_title and report_summary

Revision ID: f8e2c4a6b1d3
Revises: c1a2f6e8b3d4
Create Date: 2026-08-26 00:00:00.000000

Written by the report pipeline stage after run_report_intelligence completes.
report_title: LLM-generated meeting title (may differ from calendar/platform title).
report_summary: LLM-generated executive summary paragraph.
Both are nullable — they stay NULL until the report stage runs so the GET
/api/v1/meetings/{id}/report endpoint can fall back gracefully to the meeting's
calendar title.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f8e2c4a6b1d3"
down_revision: Union[str, None] = "c1a2f6e8b3d4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "capture_session",
        sa.Column("report_title", sa.String(length=500), nullable=True),
    )
    op.add_column(
        "capture_session",
        sa.Column("report_summary", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("capture_session", "report_summary")
    op.drop_column("capture_session", "report_title")
