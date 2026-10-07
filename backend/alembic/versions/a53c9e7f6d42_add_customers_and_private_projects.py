"""add customers and private projects

Revision ID: a53c9e7f6d42
Revises: f42b8d6e5c31
Create Date: 2026-10-08 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "a53c9e7f6d42"
down_revision: str | None = "f42b8d6e5c31"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "customer",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("org_id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column(
            "status",
            sa.Enum("ACTIVE", "ARCHIVED", native_enum=False, length=16),
            nullable=False,
        ),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["org.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("org_id", "id", name="uq_customer_org_id"),
    )
    op.create_index("ix_customer_org_status", "customer", ["org_id", "status"])
    op.create_table(
        "customer_contact",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("org_id", sa.String(length=36), nullable=False),
        sa.Column("customer_id", sa.String(length=36), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("display_name", sa.String(length=255), nullable=True),
        sa.Column("verified_rule", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["org_id", "customer_id"], ["customer.org_id", "customer.id"]
        ),
        sa.ForeignKeyConstraint(["org_id"], ["org.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("customer_id", "email", name="uq_customer_contact_email"),
    )
    op.create_index(
        "ix_customer_contact_org_email", "customer_contact", ["org_id", "email"]
    )
    op.create_table(
        "project",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("org_id", sa.String(length=36), nullable=False),
        sa.Column("customer_id", sa.String(length=36), nullable=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column(
            "visibility", sa.Enum("PRIVATE", native_enum=False, length=16), nullable=False
        ),
        sa.Column(
            "status",
            sa.Enum("ACTIVE", "ARCHIVED", native_enum=False, length=16),
            nullable=False,
        ),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["org_id", "customer_id"], ["customer.org_id", "customer.id"]
        ),
        sa.ForeignKeyConstraint(["org_id"], ["org.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("org_id", "id", name="uq_project_org_id"),
    )
    op.create_index("ix_project_org_status", "project", ["org_id", "status"])
    op.create_table(
        "project_member",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("org_id", sa.String(length=36), nullable=False),
        sa.Column("project_id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column(
            "role",
            sa.Enum("OWNER", "EDITOR", "VIEWER", native_enum=False, length=16),
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["org.id"]),
        sa.ForeignKeyConstraint(
            ["org_id", "project_id"], ["project.org_id", "project.id"]
        ),
        sa.ForeignKeyConstraint(["user_id"], ["app_user.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", "user_id", name="uq_project_member_user"),
    )
    op.create_index(
        "ix_project_member_org_user", "project_member", ["org_id", "user_id"]
    )
    op.add_column("meeting", sa.Column("owner_user_id", sa.String(length=36), nullable=True))
    op.create_foreign_key(
        "fk_meeting_owner_user", "meeting", "app_user", ["owner_user_id"], ["id"]
    )
    op.create_unique_constraint("uq_meeting_org_id", "meeting", ["org_id", "id"])
    op.create_table(
        "meeting_assignment",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("org_id", sa.String(length=36), nullable=False),
        sa.Column("meeting_id", sa.String(length=36), nullable=False),
        sa.Column("project_id", sa.String(length=36), nullable=False),
        sa.Column("assigned_by", sa.String(length=36), nullable=False),
        sa.Column(
            "source",
            sa.Enum("MANUAL", "APPROVED_RULE", native_enum=False, length=24),
            nullable=False,
        ),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["assigned_by"], ["app_user.id"]),
        sa.ForeignKeyConstraint(
            ["org_id", "meeting_id"], ["meeting.org_id", "meeting.id"]
        ),
        sa.ForeignKeyConstraint(["org_id"], ["org.id"]),
        sa.ForeignKeyConstraint(
            ["org_id", "project_id"], ["project.org_id", "project.id"]
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("meeting_id", name="uq_meeting_assignment_meeting"),
    )
    op.create_index("ix_meeting_assignment_project", "meeting_assignment", ["project_id"])


def downgrade() -> None:
    op.drop_index("ix_meeting_assignment_project", table_name="meeting_assignment")
    op.drop_table("meeting_assignment")
    op.drop_constraint("uq_meeting_org_id", "meeting", type_="unique")
    op.drop_constraint("fk_meeting_owner_user", "meeting", type_="foreignkey")
    op.drop_column("meeting", "owner_user_id")
    op.drop_index("ix_project_member_org_user", table_name="project_member")
    op.drop_table("project_member")
    op.drop_index("ix_project_org_status", table_name="project")
    op.drop_table("project")
    op.drop_index("ix_customer_contact_org_email", table_name="customer_contact")
    op.drop_table("customer_contact")
    op.drop_index("ix_customer_org_status", table_name="customer")
    op.drop_table("customer")
