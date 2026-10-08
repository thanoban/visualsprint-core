"""Bind calendar capture to an authenticated connection owner.

Historical connections remain unowned; reconnect rather than guess an owner.
"""

import sqlalchemy as sa

from alembic import op

revision = "j1d2e3f4a5b6"
down_revision = "i0c1d2e3f4a5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "calendar_connection",
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.add_column("calendar_connection", sa.Column("owner_user_id", sa.String(36), nullable=True))
    op.create_foreign_key(
        "fk_calendar_owner", "calendar_connection", "app_user", ["owner_user_id"], ["id"]
    )
    op.add_column("calendar_occurrence", sa.Column("capture_error", sa.String(64), nullable=True))


def downgrade() -> None:
    op.drop_column("calendar_connection", "enabled")
    op.drop_column("calendar_occurrence", "capture_error")
    op.drop_constraint("fk_calendar_owner", "calendar_connection", type_="foreignkey")
    op.drop_column("calendar_connection", "owner_user_id")
