"""Persist verified media cleanup before removing its secret locator."""
import sqlalchemy as sa
from alembic import op

revision = "n5b6c7d8e9f0"
down_revision = "m4a5b6c7d8e9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("deletion_job", sa.Column("cleanup_progress", sa.JSON(), nullable=False, server_default="{}"))


def downgrade() -> None:
    op.drop_column("deletion_job", "cleanup_progress")
