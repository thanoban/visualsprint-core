"""Persist revision fingerprints on saved answer citations."""
import sqlalchemy as sa
from alembic import op

revision = "k2e3f4a5b6c7"
down_revision = "j1d2e3f4a5b6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("answer_citation", sa.Column("source_hash", sa.String(64), nullable=True))


def downgrade() -> None:
    op.drop_column("answer_citation", "source_hash")
