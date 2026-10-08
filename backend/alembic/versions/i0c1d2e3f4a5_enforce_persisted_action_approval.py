"""Enforce approval for SQLAlchemy enum names as well as legacy values.

Revision ID: i0c1d2e3f4a5
Revises: h9b0c1d2e3f4

Existing approved/executed rows without an actor and timestamp intentionally
block this migration. Reconcile them from real audit evidence before retrying;
never manufacture approvals or silently delete historical actions. PostgreSQL
validates existing rows atomically when adding the corrected constraint.
"""

from alembic import op

revision = "i0c1d2e3f4a5"
down_revision = "h9b0c1d2e3f4"
branch_labels = None
depends_on = None

NAME = "ck_action_requires_approval"
PREDICATE = (
    "status NOT IN ('APPROVED','EXECUTED','approved','executed') "
    "OR (approved_by_person_id IS NOT NULL AND approved_at IS NOT NULL)"
)


def upgrade() -> None:
    op.drop_constraint(NAME, "proposed_action", type_="check")
    op.create_check_constraint(NAME, "proposed_action", PREDICATE)


def downgrade() -> None:
    # A rollback must not reopen the original uppercase enum loophole.
    # Retain the stronger constraint; the old schema supports both columns.
    pass
