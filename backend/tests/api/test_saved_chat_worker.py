"""Exercise HTTP intent -> leased worker -> persisted, re-authorized answer."""

import json
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import sessionmaker

from app.db.models import (
    AnswerCitation,
    CaptureSession,
    ChatMessage,
    Confidence,
    KnowledgeEvidence,
    KnowledgeItem,
    KnowledgeType,
    LlmCall,
    Meeting,
    MeetingAssignment,
    MessageRole,
    MessageState,
    Org,
    OrgMember,
    OutboxEvent,
    OutboxStatus,
    Project,
    ProjectMember,
    User,
    Utterance,
)
from app.modules.conversations.jobs import generate_next

ACTOR = "11111111-1111-1111-1111-111111111111"


@pytest.fixture
def chat(client, db_session):
    db = db_session
    org = Org(name="Chat tests", pilot_features_enabled=True)
    db.add(org)
    db.add(User(id=ACTOR, email="founder@example.test"))
    db.flush()
    db.add(OrgMember(org_id=org.id, user_id=ACTOR, role="owner"))
    project = Project(org_id=org.id, name="Acme")
    db.add(project)
    db.flush()
    db.add(ProjectMember(org_id=org.id, project_id=project.id, user_id=ACTOR, role="owner"))
    meeting = Meeting(org_id=org.id, platform="google_meet", owner_user_id=ACTOR, title="Kickoff")
    db.add(meeting)
    db.flush()
    db.add(
        MeetingAssignment(
            org_id=org.id, meeting_id=meeting.id, project_id=project.id, assigned_by=ACTOR
        )
    )
    session = CaptureSession(org_id=org.id, meeting_id=meeting.id, mode="B")
    db.add(session)
    db.flush()
    utterance = Utterance(
        org_id=org.id, capture_session_id=session.id, text="We chose Postgres.", start_s=0, end_s=2
    )
    item = KnowledgeItem(
        org_id=org.id,
        capture_session_id=session.id,
        type=KnowledgeType.DECISION,
        statement="The team chose Postgres.",
        confidence=Confidence.VERIFIED,
    )
    db.add_all([utterance, item])
    db.flush()
    db.add(KnowledgeEvidence(org_id=org.id, knowledge_item_id=item.id, utterance_id=utterance.id))
    db.commit()
    root = f"/api/v2/workspaces/{org.id}"
    thread = client.post(
        root + "/threads", json={"scope_kind": "project", "scope_id": project.id}
    ).json()
    text = {"text": "What database did we choose?", "client_request_id": str(uuid.uuid4())}
    assert client.post(root + f"/threads/{thread['id']}/messages", json=text).status_code == 202
    yield org, project, meeting, item, utterance, root + f"/threads/{thread['id']}", text


class Model:
    calls = 0
    ids = None
    change = None

    async def complete_structured(self, *, schema, user_content, **kwargs):
        from app.interfaces.llm import LlmUsage

        self.calls += 1
        content = json.loads(user_content)
        if self.change:
            self.change()
        ids = self.ids if self.ids is not None else [content["evidence"][0]["id"]]
        return schema(item_ids=ids), LlmUsage(input_tokens=100, output_tokens=10)


async def run(db, model):
    return await generate_next(
        sessionmaker(bind=db.bind, expire_on_commit=False),
        llm_factory=lambda: model,
        worker_id="test-chat",
    )


@pytest.mark.asyncio
async def test_http_worker_restore_citations_and_retry_identity(client, db_session, chat):
    _, _, meeting, item, _, path, text = chat
    model = Model()
    assert await run(db_session, model)
    assert not await run(db_session, model)
    rows = client.get(path + "/messages").json()
    assert rows[-1]["state"] == "done" and "The team chose Postgres." in rows[-1]["content"]
    assert len(rows[-1]["citations"]) == 1
    assert rows[-1]["citations"][0]["capture_session_id"] == item.capture_session_id
    assert rows[-1]["citations"][0]["capture_session_id"] != meeting.id
    assert client.post(path + "/messages", json=text).status_code == 202
    assert db_session.scalar(select(func.count()).select_from(ChatMessage)) == 2
    assert db_session.scalar(select(func.count()).select_from(LlmCall)) == 1
    assert model.calls == 1


@pytest.mark.asyncio
async def test_changed_transcript_redacts_entire_old_answer(client, db_session, chat):
    _, _, _, _, utterance, path, _ = chat
    await run(db_session, Model())
    utterance.text = "We did NOT choose Postgres."
    db_session.commit()
    answer = client.get(path + "/messages").json()[-1]
    assert answer["state"] == "failed" and "The team chose" not in answer["content"]
    assert answer["citations"] == []


@pytest.mark.asyncio
async def test_access_revoked_during_model_call_cannot_publish(client, db_session, chat):
    _, project, *_ = chat
    model = Model()

    def revoke():
        db_session.query(ProjectMember).filter_by(project_id=project.id).delete()
        db_session.commit()

    model.change = revoke
    await run(db_session, model)
    db_session.expire_all()
    answer = db_session.scalar(select(ChatMessage).where(ChatMessage.role == MessageRole.ASSISTANT))
    assert answer.state == MessageState.FAILED and "Postgres" not in answer.content
    assert db_session.scalar(select(func.count()).select_from(AnswerCitation)) == 0


@pytest.mark.asyncio
async def test_unknown_model_id_is_not_a_citable_fact(client, db_session, chat):
    model = Model()
    model.ids = ["invented-private-meeting-id"]
    await run(db_session, model)
    answer = client.get(chat[-2] + "/messages").json()[-1]
    assert answer["state"] == "failed" and answer["citations"] == []


@pytest.mark.asyncio
async def test_missing_model_retries_bounded_without_logging_vendor_body(client, db_session, chat):
    class Broken:
        async def complete_structured(self, **kwargs):
            raise RuntimeError("password-and-private-transcript")

    for _ in range(3):
        await run(db_session, Broken())
        db_session.expire_all()
        event = db_session.scalar(
            select(OutboxEvent).where(OutboxEvent.operation == "conversation.answer")
        )
        event.run_at = datetime.now(UTC) - timedelta(seconds=1)
        db_session.commit()
    assert event.status == OutboxStatus.FAILED
    assert client.get(chat[-2] + "/messages").json()[-1]["content"] == "chat_model_unavailable"
    assert all(row.error == "chat_model_unavailable" for row in db_session.scalars(select(LlmCall)))


@pytest.mark.asyncio
async def test_expired_lease_fence_cannot_publish_old_result(client, db_session, chat):
    model = Model()

    def steal():
        event = db_session.scalar(
            select(OutboxEvent).where(OutboxEvent.operation == "conversation.answer")
        )
        event.fencing_version += 1
        event.locked_by = "replacement-worker"
        db_session.commit()

    model.change = steal
    await run(db_session, model)
    db_session.expire_all()
    answer = db_session.scalar(select(ChatMessage).where(ChatMessage.role == MessageRole.ASSISTANT))
    assert answer.state == MessageState.GENERATING and answer.content == ""


def test_saved_history_cursor_pages_tied_messages_without_loss(client, db_session, chat):
    org, *_ = chat
    path = chat[-2]
    timestamp = datetime.now(UTC) + timedelta(minutes=1)
    ids = [str(uuid.UUID(int=index + 1)) for index in range(105)]
    db_session.add_all(
        [
            ChatMessage(
                id=identifier,
                org_id=org.id,
                thread_id=path.rsplit("/", 1)[-1],
                role=MessageRole.USER,
                state=MessageState.DONE,
                content=identifier,
                created_at=timestamp,
            )
            for identifier in ids
        ]
    )
    db_session.commit()
    recent = client.get(path + "/messages").json()
    assert [row["id"] for row in recent] == ids[5:]
    older = client.get(path + f"/messages?before_id={recent[0]['id']}").json()
    assert len(older) == 7  # Five older seeded messages and the initial question/answer.
    assert set(row["id"] for row in recent).isdisjoint(row["id"] for row in older)
    assert set(ids) <= {row["id"] for row in [*recent, *older]}
    assert client.get(path + "/messages?before_id=not-owned").status_code == 404
    assert client.get(path + "/messages?limit=101").status_code == 422
