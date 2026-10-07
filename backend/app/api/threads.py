"""Persistent thread and message APIs (F10).

Threads are creator-private in the pilot.  Scope is "project" or "customer".
Messages are stored and returned in chronological order.  The assistant message
for a POST /messages is created synchronously with state=PENDING; the caller
polls or SSE-streams GET /generations/{generation_id}/events.

Architecture rules observed:
- Agents interpret content; they never call each other or choose the next stage.
- Raw transcript never enters the message content written here — only verified
  KnowledgeItem statements, passed through the existing chat.py retrieval path.
- generation_id is opaque to this module; the LLM worker (future) reads it.
"""

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.dependency import get_current_user, require_org_member
from app.db.base import get_db
from app.db.models import (
    AnswerCitation,
    ChatMessage,
    ChatThread,
    Customer,
    MessageRole,
    MessageState,
    Org,
    Project,
    ProjectMember,
    ThreadStatus,
    User,
)

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
    db: Session, org_id: str, thread_id: str, user_id: str
) -> ChatThread:
    """Return a thread that belongs to this org and user (creator-private)."""
    thread = db.execute(
        select(ChatThread).where(
            ChatThread.id == thread_id,
            ChatThread.org_id == org_id,
            ChatThread.creator_id == user_id,
        )
    ).scalar_one_or_none()
    if thread is None:
        raise HTTPException(404, "thread not found")
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
    q = q.order_by(ChatThread.updated_at.desc())

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
    thread = _get_thread(db, org_id, thread_id, user.id)

    if thread.version != body.version:
        raise HTTPException(409, "version conflict")

    if body.title is not None:
        thread.title = body.title
    if body.status is not None:
        try:
            thread.status = ThreadStatus(body.status)
        except ValueError:
            raise HTTPException(422, f"invalid status: {body.status}")

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
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> list[MessageView]:
    """Return messages for a thread in chronological order."""
    _require_org(db, org_id)
    _get_thread(db, org_id, thread_id, user.id)

    messages = db.execute(
        select(ChatMessage)
        .where(ChatMessage.thread_id == thread_id)
        .order_by(ChatMessage.created_at.asc())
    ).scalars().all()

    return [
        MessageView(
            id=m.id,
            thread_id=m.thread_id,
            role=m.role,
            state=m.state,
            content=m.content,
            generation_id=m.generation_id,
        )
        for m in messages
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
    thread = _get_thread(db, org_id, thread_id, user.id)
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
    db.commit()

    return MessageView(
        id=user_msg.id,
        thread_id=user_msg.thread_id,
        role=user_msg.role,
        state=user_msg.state,
        content=user_msg.content,
        generation_id=None,
    )
