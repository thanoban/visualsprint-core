"""Persistent thread and message APIs (F10).

Threads are creator-private in the pilot.  Scope is "project" or "customer".
Messages are stored and returned in chronological order.  The assistant message
for a POST /messages is created atomically with a durable answer-generation
outbox event. A separately supervised worker publishes cited evidence answers;
clients poll persisted state. Server-sent streaming is not implemented.

Architecture rules observed:
- Agents interpret content; they never call each other or choose the next stage.
- Raw transcript never enters the message content written here — only verified
  KnowledgeItem statements with current transcript evidence and source revisions.
- generation_id and fenced outbox claims prevent stale workers publishing answers.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import and_, exists, or_, select
from sqlalchemy.orm import Session

from app.auth.dependency import get_current_user, require_org_member
from app.db.base import get_db
from app.db.models import (
    AnswerCitation,
    ChatMessage,
    ChatThread,
    Customer,
    MeetingAssignment,
    MessageRole,
    MessageState,
    Org,
    OutboxEvent,
    OutboxStatus,
    Project,
    ProjectMember,
    ThreadStatus,
    User,
)
from app.modules.conversations.evidence import citation_current
from app.modules.projects.access import can_read_meeting

router = APIRouter(prefix="/api/v2/workspaces/{org_id}", tags=["threads"])


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _require_org(db: Session, org_id: str) -> None:
    if db.get(Org, org_id) is None:
        raise HTTPException(404, "workspace not found")


def _resolve_scope(db: Session, org_id: str, scope_kind: str, scope_id: str) -> None:
    """Validate that the scope entity exists in this org."""
    if scope_kind == "project":
        p = db.get(Project, scope_id)
        if p is None or p.org_id != org_id:
            raise HTTPException(404, "project not found")
    elif scope_kind == "customer":
        c = db.get(Customer, scope_id)
        if c is None or c.org_id != org_id:
            raise HTTPException(404, "customer not found")
    else:
        raise HTTPException(422, "scope_kind must be 'project' or 'customer'")


def _require_scope_read(
    db: Session, org_id: str, scope_kind: str, scope_id: str, user_id: str
) -> None:
    """For project scope: require project membership.  Customer scope: org membership is enough."""
    if scope_kind == "project":
        member = db.execute(
            select(ProjectMember).where(
                ProjectMember.org_id == org_id,
                ProjectMember.project_id == scope_id,
                ProjectMember.user_id == user_id,
            )
        ).scalar_one_or_none()
        if member is None:
            raise HTTPException(404, "project not found")


def _get_thread(
    db: Session, org_id: str, thread_id: str, user_id: str, *, lock: bool = False
) -> ChatThread:
    """Return a thread that belongs to this org and user (creator-private)."""
    query = select(ChatThread).where(
        ChatThread.id == thread_id,
        ChatThread.org_id == org_id,
        ChatThread.creator_id == user_id,
    )
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    thread = db.execute(query).scalar_one_or_none()
    if thread is None:
        raise HTTPException(404, "thread not found")
    _resolve_scope(db, org_id, thread.scope_kind, thread.scope_id)
    _require_scope_read(db, org_id, thread.scope_kind, thread.scope_id, user_id)
    return thread


# --------------------------------------------------------------------------- #
# Request/response models
# --------------------------------------------------------------------------- #


class ThreadCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scope_kind: str = Field(pattern="^(project|customer)$")
    scope_id: str = Field(min_length=1, max_length=36)
    title: str = Field(default="", max_length=255)


class ThreadUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=1)
    title: str | None = Field(default=None, max_length=255)
    status: str | None = None


class ThreadView(BaseModel):
    id: str
    scope_kind: str
    scope_id: str
    title: str
    status: str
    version: int


class MessageCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=8192)
    client_request_id: str = Field(min_length=36, max_length=36)


class MessageView(BaseModel):
    id: str
    thread_id: str
    role: str
    state: str
    content: str
    generation_id: str | None = None
    citations: list[dict[str, str]] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Thread endpoints
# --------------------------------------------------------------------------- #


@router.post("/threads", response_model=ThreadView, status_code=201)
def create_thread(
    org_id: str,
    body: ThreadCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> ThreadView:
    """Create a new creator-private thread scoped to a project or customer."""
    _require_org(db, org_id)
    _resolve_scope(db, org_id, body.scope_kind, body.scope_id)
    _require_scope_read(db, org_id, body.scope_kind, body.scope_id, user.id)

    thread = ChatThread(
        org_id=org_id,
        scope_kind=body.scope_kind,
        scope_id=body.scope_id,
        creator_id=user.id,
        title=body.title,
        status=ThreadStatus.ACTIVE,
    )
    db.add(thread)
    db.commit()
    return ThreadView(
        id=thread.id,
        scope_kind=thread.scope_kind,
        scope_id=thread.scope_id,
        title=thread.title,
        status=thread.status,
        version=thread.version,
    )


@router.get("/threads", response_model=list[ThreadView])
def list_threads(
    org_id: str,
    scope_kind: str | None = None,
    scope_id: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> list[ThreadView]:
    """List the caller's threads (creator-private), optionally filtered by scope."""
    _require_org(db, org_id)

    q = select(ChatThread).where(
        ChatThread.org_id == org_id,
        ChatThread.creator_id == user.id,
    )
    if scope_kind is not None:
        q = q.where(ChatThread.scope_kind == scope_kind)
    if scope_id is not None:
        q = q.where(ChatThread.scope_id == scope_id)
    project_access = exists().where(
        ProjectMember.org_id == org_id,
        ProjectMember.project_id == ChatThread.scope_id,
        ProjectMember.user_id == user.id,
    )
    customer_exists = exists().where(Customer.org_id == org_id, Customer.id == ChatThread.scope_id)
    q = q.where(
        or_(
            and_(ChatThread.scope_kind == "project", project_access),
            and_(ChatThread.scope_kind == "customer", customer_exists),
        )
    )
    q = q.order_by(ChatThread.updated_at.desc(), ChatThread.id).limit(100)

    threads = db.execute(q).scalars().all()
    return [
        ThreadView(
            id=t.id,
            scope_kind=t.scope_kind,
            scope_id=t.scope_id,
            title=t.title,
            status=t.status,
            version=t.version,
        )
        for t in threads
    ]


@router.patch("/threads/{thread_id}", response_model=ThreadView)
def update_thread(
    org_id: str,
    thread_id: str,
    body: ThreadUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> ThreadView:
    """Update thread title or archive it.  Creator only; optimistic version check."""
    _require_org(db, org_id)
    thread = _get_thread(db, org_id, thread_id, user.id, lock=True)

    if thread.version != body.version:
        raise HTTPException(409, "version conflict")

    if body.title is not None:
        thread.title = body.title
    if body.status is not None:
        try:
            thread.status = ThreadStatus(body.status)
        except ValueError as exc:
            raise HTTPException(422, "invalid thread status") from exc

    thread.version += 1
    db.commit()
    return ThreadView(
        id=thread.id,
        scope_kind=thread.scope_kind,
        scope_id=thread.scope_id,
        title=thread.title,
        status=thread.status,
        version=thread.version,
    )


# --------------------------------------------------------------------------- #
# Message endpoints
# --------------------------------------------------------------------------- #


@router.get("/threads/{thread_id}/messages", response_model=list[MessageView])
def list_messages(
    org_id: str,
    thread_id: str,
    before_id: str | None = Query(default=None, max_length=36),
    limit: int = Query(default=100, ge=1, le=100),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> list[MessageView]:
    """Return messages for a thread in chronological order."""
    _require_org(db, org_id)
    thread = _get_thread(db, org_id, thread_id, user.id)

    query = select(ChatMessage).where(
        ChatMessage.org_id == org_id, ChatMessage.thread_id == thread_id
    )
    if before_id is not None:
        cursor = db.scalar(
            select(ChatMessage).where(
                ChatMessage.id == before_id,
                ChatMessage.org_id == org_id,
                ChatMessage.thread_id == thread_id,
            )
        )
        if cursor is None:
            raise HTTPException(404, "message cursor not found")
        query = query.where(
            or_(
                ChatMessage.created_at < cursor.created_at,
                and_(ChatMessage.created_at == cursor.created_at, ChatMessage.id < cursor.id),
            )
        )
    messages = (
        db.execute(
            query.order_by(ChatMessage.created_at.desc(), ChatMessage.id.desc()).limit(limit)
        )
        .scalars()
        .all()
    )

    # Revoke the whole generated answer when any cited source is unavailable.
    # Filtering the chips alone still exposes hidden facts in assistant text.
    for message in messages:
        if message.role != MessageRole.ASSISTANT or message.state != MessageState.DONE:
            continue
        citations = db.scalars(
            select(AnswerCitation).where(
                AnswerCitation.org_id == org_id, AnswerCitation.message_id == message.id
            )
        ).all()
        for citation in citations:
            assignment = db.scalar(
                select(MeetingAssignment).where(
                    MeetingAssignment.org_id == org_id,
                    MeetingAssignment.meeting_id == citation.meeting_id,
                )
            )
            in_scope = assignment is not None and (
                assignment.project_id == thread.scope_id
                if thread.scope_kind == "project"
                else db.scalar(
                    select(Project.id).where(
                        Project.org_id == org_id,
                        Project.id == assignment.project_id,
                        Project.customer_id == thread.scope_id,
                    )
                )
                is not None
            )
            if (
                not in_scope
                or not can_read_meeting(db, org_id, citation.meeting_id, user.id)
                or not citation_current(db, thread, citation)
            ):
                # Do not mutate the stored row while creating a read projection.
                break
        else:
            continue
        db.expunge(message)
        message.content = "Source access changed. Ask again using your current meeting access."
        message.state = MessageState.FAILED

    return [
        MessageView(
            id=m.id,
            thread_id=m.thread_id,
            role=m.role,
            state=m.state,
            content=m.content,
            generation_id=m.generation_id,
            citations=[
                {"meeting_id": c.meeting_id, "knowledge_item_id": c.knowledge_item_id or ""}
                for c in db.scalars(
                    select(AnswerCitation).where(
                        AnswerCitation.message_id == m.id, AnswerCitation.org_id == org_id
                    )
                )
            ]
            if m.state == MessageState.DONE and m.role == MessageRole.ASSISTANT
            else [],
        )
        for m in reversed(messages)
    ]


@router.post("/threads/{thread_id}/messages", response_model=MessageView, status_code=202)
def send_message(
    org_id: str,
    thread_id: str,
    body: MessageCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> MessageView:
    """Append a user message and create a pending assistant reply.

    The user message is stored with state=DONE immediately.
    An assistant message is created with state=PENDING and a generation_id
    that the LLM worker (future) will read to stream or complete the answer.

    Idempotent: if client_request_id already exists for this thread, the
    existing user message is returned (202 with its original content).
    """
    _require_org(db, org_id)
    thread = _get_thread(db, org_id, thread_id, user.id, lock=True)
    if thread.status == ThreadStatus.ARCHIVED:
        raise HTTPException(409, "thread is archived")

    # Idempotency check
    existing = db.execute(
        select(ChatMessage).where(
            ChatMessage.thread_id == thread_id,
            ChatMessage.client_request_id == body.client_request_id,
        )
    ).scalar_one_or_none()
    if existing is not None:
        if existing.content != body.text:
            raise HTTPException(409, "client request ID was already used for different text")
        return MessageView(
            id=existing.id,
            thread_id=existing.thread_id,
            role=existing.role,
            state=existing.state,
            content=existing.content,
            generation_id=existing.generation_id,
        )

    user_msg = ChatMessage(
        org_id=org_id,
        thread_id=thread_id,
        role=MessageRole.USER,
        state=MessageState.DONE,
        content=body.text,
        client_request_id=body.client_request_id,
    )
    db.add(user_msg)
    db.flush()

    generation_id = str(uuid.uuid4())
    assistant_msg = ChatMessage(
        org_id=org_id,
        thread_id=thread_id,
        role=MessageRole.ASSISTANT,
        state=MessageState.PENDING,
        content="",
        generation_id=generation_id,
    )
    db.add(assistant_msg)
    db.flush()
    db.add(
        OutboxEvent(
            org_id=org_id,
            operation="conversation.answer",
            entity_id=assistant_msg.id,
            input_revision=generation_id,
            payload={"question_id": user_msg.id},
            max_attempts=3,
        )
    )
    db.commit()

    return MessageView(
        id=user_msg.id,
        thread_id=user_msg.thread_id,
        role=user_msg.role,
        state=user_msg.state,
        content=user_msg.content,
        generation_id=None,
    )


@router.post(
    "/threads/{thread_id}/messages/{message_id}/retry", response_model=MessageView, status_code=202
)
def retry_answer(
    org_id: str,
    thread_id: str,
    message_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> MessageView:
    thread = _get_thread(db, org_id, thread_id, user.id, lock=True)
    if thread.status != ThreadStatus.ACTIVE:
        raise HTTPException(409, "thread is archived")
    message = db.scalar(
        select(ChatMessage)
        .where(
            ChatMessage.org_id == org_id,
            ChatMessage.thread_id == thread_id,
            ChatMessage.id == message_id,
            ChatMessage.role == MessageRole.ASSISTANT,
        )
        .with_for_update()
    )
    if message is None:
        raise HTTPException(404, "answer not found")
    if message.state == MessageState.FAILED:
        event = db.scalar(
            select(OutboxEvent)
            .where(
                OutboxEvent.entity_id == message.id, OutboxEvent.operation == "conversation.answer"
            )
            .with_for_update()
        )
        if event is None:
            raise HTTPException(409, "legacy answer cannot be retried; ask a new question")
        from datetime import UTC, datetime

        event.status, event.attempts, event.error_code = OutboxStatus.PENDING, 0, None
        event.run_at = datetime.now(UTC)
        event.locked_at, event.locked_by = None, None
        event.fencing_version += 1
        message.state, message.content = MessageState.PENDING, ""
        db.commit()
    return MessageView(
        id=message.id,
        thread_id=thread_id,
        role=message.role,
        state=message.state,
        content=message.content,
        generation_id=message.generation_id,
    )
