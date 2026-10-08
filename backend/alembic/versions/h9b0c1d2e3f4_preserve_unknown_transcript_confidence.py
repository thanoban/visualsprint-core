"""Preserve unknown confidence and track transcript freshness without raw text.

Revision ID: h9b0c1d2e3f4
Revises: g8a9b0c1d2e3
"""

import sqlalchemy as sa
from alembic import op

revision = "h9b0c1d2e3f4"
down_revision = "g8a9b0c1d2e3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("utterance", "asr_confidence", existing_type=sa.Float(), nullable=True)
    op.add_column(
        "capture_attempt", sa.Column("transcript_revision_hash", sa.String(64), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("capture_attempt", "transcript_revision_hash")
    # Historical code requires a number; zero is the conservative downgrade
    # fallback. Export unknown-confidence data before this lossy rollback.
    op.execute(sa.text("UPDATE utterance SET asr_confidence = 0 WHERE asr_confidence IS NULL"))
    op.alter_column("utterance", "asr_confidence", existing_type=sa.Float(), nullable=False)
