"""Store bounded text exports behind authenticated, revision-checked downloads."""
import sqlalchemy as sa
from alembic import op

revision = "l3f4a5b6c7d8"
down_revision = "k2e3f4a5b6c7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("export_job", sa.Column("manifest", sa.JSON(), nullable=True))
    op.add_column("export_job", sa.Column("source_hash", sa.String(64), nullable=True))


def downgrade() -> None:
    op.drop_column("export_job", "source_hash")
    op.drop_column("export_job", "manifest")
