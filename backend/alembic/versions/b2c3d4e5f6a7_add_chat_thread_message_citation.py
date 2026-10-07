"""Add chat_thread, chat_message, answer_citation tables for F10.

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-10-08

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b2c3d4e5f6a7"
down_revision: str | None = "a1b2c3d4e5f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "chat_thread",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("org_id", sa.String(36), sa.ForeignKey("org.id"), nullable=False),
        sa.Column("scope_kind", sa.String(16), nullable=False),
        sa.Column("scope_id", sa.String(36), nullable=False),
        sa.Column("creator_id", sa.String(36), sa.ForeignKey("app_user.id"), nullable=False),
        sa.Column("title", sa.String(255), nullable=False, server_default=""),
        sa.Column("status", sa.String(16), nullable=False, server_default="active"),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
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
        sa.CheckConstraint("scope_kind IN ('project', 'customer')", name="ck_ct_scope_kind"),
    )
    op.create_index(
        "ix_ct_org_creator_scope",
        "chat_thread",
        ["org_id", "creator_id", "scope_kind", "scope_id"],
    )
    op.create_index("ix_ct_scope", "chat_thread", ["scope_kind", "scope_id"])

    op.create_table(
        "chat_message",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("org_id", sa.String(36), sa.ForeignKey("org.id"), nullable=False),
        sa.Column("thread_id", sa.String(36), sa.ForeignKey("chat_thread.id"), nullable=False),
        sa.Column("role", sa.String(16), nullable=False),
        sa.Column("state", sa.String(16), nullable=False, server_default="done"),
        sa.Column("content", sa.Text(), nullable=False, server_default=""),
        sa.Column("client_request_id", sa.String(36), nullable=True),
        sa.Column("generation_id", sa.String(36), nullable=True),
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
        sa.UniqueConstraint("thread_id", "client_request_id", name="uq_cm_thread_client_req"),
    )
    op.create_index("ix_cm_thread", "chat_message", ["thread_id"])

    op.create_table(
        "answer_citation",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("org_id", sa.String(36), sa.ForeignKey("org.id"), nullable=False),
        sa.Column("message_id", sa.String(36), sa.ForeignKey("chat_message.id"), nullable=False),
        sa.Column("meeting_id", sa.String(36), sa.ForeignKey("meeting.id"), nullable=False),
        sa.Column("knowledge_item_id", sa.String(36), sa.ForeignKey("knowledge_item.id"), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
    )
    op.create_index("ix_ac_message", "answer_citation", ["message_id"])
    op.create_index("ix_ac_meeting", "answer_citation", ["meeting_id"])


def downgrade() -> None:
    op.drop_index("ix_ac_meeting", table_name="answer_citation")
    op.drop_index("ix_ac_message", table_name="answer_citation")
    op.drop_table("answer_citation")

    op.drop_index("ix_cm_thread", table_name="chat_message")
    op.drop_table("chat_message")

    op.drop_index("ix_ct_scope", table_name="chat_thread")
    op.drop_index("ix_ct_org_creator_scope", table_name="chat_thread")
    op.drop_table("chat_thread")
