"""Hide deleting scopes before external cleanup and preserve accepted scope identity."""
import sqlalchemy as sa
from alembic import op

revision = "m4a5b6c7d8e9"
down_revision = "l3f4a5b6c7d8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    for table in ("org", "project", "meeting"):
        op.add_column(table, sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("deletion_job", sa.Column("target_meeting_ids", sa.JSON(), nullable=False, server_default="[]"))


def downgrade() -> None:
    op.drop_column("deletion_job", "target_meeting_ids")
    for table in ("meeting", "project", "org"):
        op.drop_column(table, "deleted_at")
