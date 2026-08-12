"""add participant intelligence tables

Revision ID: b2a1c7f5e9d0
Revises: 6dbb5b27ddb6
Create Date: 2026-08-11 18:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import pgvector.sqlalchemy


revision: str = "b2a1c7f5e9d0"
down_revision: Union[str, None] = "6dbb5b27ddb6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("person", sa.Column("user_id", sa.String(length=36), nullable=True))
    op.add_column("person", sa.Column("voiceprint", pgvector.sqlalchemy.Vector(dim=512), nullable=True))
    op.add_column("person", sa.Column("voiceprint_sample_count", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("person", sa.Column("voiceprint_reliable", sa.Boolean(), nullable=False, server_default=sa.true()))
    op.create_foreign_key("fk_person_user_id_app_user", "person", "app_user", ["user_id"], ["id"])
    op.create_index("ix_person_org_email", "person", ["org_id", "email"], unique=False)
    op.create_index("ix_person_org_user", "person", ["org_id", "user_id"], unique=False)

    op.add_column("speaker_turn", sa.Column("audio_track_id", sa.String(length=36), nullable=True))
    op.create_foreign_key(
        "fk_speaker_turn_audio_track_id",
        "speaker_turn",
        "audio_track",
        ["audio_track_id"],
        ["id"],
    )
    op.add_column("session_speaker", sa.Column("audio_track_id", sa.String(length=36), nullable=True))
    op.add_column(
        "session_speaker",
        sa.Column("embedding", pgvector.sqlalchemy.Vector(dim=512), nullable=True),
    )
    op.create_foreign_key(
        "fk_session_speaker_audio_track_id",
        "session_speaker",
        "audio_track",
        ["audio_track_id"],
        ["id"],
    )
    op.drop_constraint("uq_session_speaker_cluster", "session_speaker", type_="unique")
    op.create_unique_constraint(
        "uq_session_speaker_track_cluster",
        "session_speaker",
        ["capture_session_id", "audio_track_id", "cluster_id"],
    )

    op.create_table(
        "platform_speaker_label",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("org_id", sa.String(length=36), nullable=False),
        sa.Column("capture_session_id", sa.String(length=36), nullable=False),
        sa.Column("start_s", sa.Float(), nullable=False),
        sa.Column("end_s", sa.Float(), nullable=False),
        sa.Column("display_name", sa.String(length=255), nullable=False),
        sa.Column("provider", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["capture_session_id"], ["capture_session.id"]),
        sa.ForeignKeyConstraint(["org_id"], ["org.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_platformlabel_session_start",
        "platform_speaker_label",
        ["capture_session_id", "start_s"],
        unique=False,
    )

    op.add_column("knowledge_item", sa.Column("owner_candidate_person_id", sa.String(length=36), nullable=True))
    op.add_column("knowledge_item", sa.Column("owner_utterance_id", sa.String(length=36), nullable=True))
    op.add_column("knowledge_item", sa.Column("owner_source", sa.String(length=32), nullable=True))
    op.add_column("knowledge_item", sa.Column("owner_attribution_confidence", sa.Float(), nullable=True))
    op.create_foreign_key(
        "fk_knowledge_item_owner_candidate_person_id",
        "knowledge_item",
        "person",
        ["owner_candidate_person_id"],
        ["id"],
    )
    op.create_foreign_key(
        "fk_knowledge_item_owner_utterance_id",
        "knowledge_item",
        "utterance",
        ["owner_utterance_id"],
        ["id"],
    )
    op.create_index(
        "ix_ki_org_owner_state",
        "knowledge_item",
        ["org_id", "owner_person_id", "lifecycle_state"],
        unique=False,
    )

    op.add_column("proposed_action", sa.Column("external_id", sa.String(length=255), nullable=True))

    op.create_table(
        "work_evidence",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("org_id", sa.String(length=36), nullable=False),
        sa.Column("action_id", sa.String(length=36), nullable=False),
        sa.Column("knowledge_item_id", sa.String(length=36), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("external_id", sa.String(length=255), nullable=False),
        sa.Column("status", sa.Enum("OPEN", "CLOSED", "UNKNOWN", name="workstatus", native_enum=False, length=16), nullable=False),
        sa.Column("status_label", sa.String(length=255), nullable=False),
        sa.Column("external_url", sa.String(length=1000), nullable=True),
        sa.Column("raw", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["action_id"], ["proposed_action.id"]),
        sa.ForeignKeyConstraint(["knowledge_item_id"], ["knowledge_item.id"]),
        sa.ForeignKeyConstraint(["org_id"], ["org.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_workevidence_action", "work_evidence", ["action_id"], unique=False)
    op.create_index("ix_workevidence_item", "work_evidence", ["knowledge_item_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_workevidence_item", table_name="work_evidence")
    op.drop_index("ix_workevidence_action", table_name="work_evidence")
    op.drop_table("work_evidence")
    op.drop_column("proposed_action", "external_id")

    op.drop_index("ix_ki_org_owner_state", table_name="knowledge_item")
    op.drop_constraint("fk_knowledge_item_owner_utterance_id", "knowledge_item", type_="foreignkey")
    op.drop_constraint("fk_knowledge_item_owner_candidate_person_id", "knowledge_item", type_="foreignkey")
    op.drop_column("knowledge_item", "owner_attribution_confidence")
    op.drop_column("knowledge_item", "owner_source")
    op.drop_column("knowledge_item", "owner_utterance_id")
    op.drop_column("knowledge_item", "owner_candidate_person_id")

    op.drop_index("ix_platformlabel_session_start", table_name="platform_speaker_label")
    op.drop_table("platform_speaker_label")

    op.drop_constraint("uq_session_speaker_track_cluster", "session_speaker", type_="unique")
    op.create_unique_constraint(
        "uq_session_speaker_cluster",
        "session_speaker",
        ["capture_session_id", "cluster_id"],
    )
    op.drop_constraint("fk_session_speaker_audio_track_id", "session_speaker", type_="foreignkey")
    op.drop_column("session_speaker", "embedding")
    op.drop_column("session_speaker", "audio_track_id")
    op.drop_constraint("fk_speaker_turn_audio_track_id", "speaker_turn", type_="foreignkey")
    op.drop_column("speaker_turn", "audio_track_id")

    op.drop_index("ix_person_org_user", table_name="person")
    op.drop_index("ix_person_org_email", table_name="person")
    op.drop_constraint("fk_person_user_id_app_user", "person", type_="foreignkey")
    op.drop_column("person", "voiceprint_reliable")
    op.drop_column("person", "voiceprint_sample_count")
    op.drop_column("person", "voiceprint")
    op.drop_column("person", "user_id")
