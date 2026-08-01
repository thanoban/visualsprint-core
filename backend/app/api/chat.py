"""Evidence-grounded cross-meeting chat — POST /api/v1/chat.

Hybrid retrieval over `knowledge_item`: Postgres full-text search (working path
today) plus a structurally-correct pgvector similarity query that stays inert
until a question-embedding pipeline exists (see `_vector_candidates`). Matches
are expanded one hop along `knowledge_edge` to surface superseding/recurring/
related items. The answer is synthesized ONLY from the retrieved
`KnowledgeItem.statement` values and their evidence metadata — never raw
transcript text — matching docs/05-data-model.md § Retrieval.
"""

import re
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.adapters.blobstore_s3 import get_blobstore
from app.db.base import get_db
from app.db.models import (
    CaptureSession,
    Keyframe,
    KnowledgeEdge,
    KnowledgeEvidence,
    KnowledgeItem,
    Meeting,
    Person,
    Utterance,
)
from app.interfaces.llm import LlmClient

router = APIRouter(prefix="/api/v1/chat", tags=["chat"])

MAX_FTS_CANDIDATES = 8
MAX_VECTOR_CANDIDATES = 8
MAX_EDGE_ROWS = 20
MAX_EVIDENCE_PER_ITEM = 2


class ChatRequest(BaseModel):
    org_id: str
    question: str
    meeting_id: str | None = None
    history: list[dict] | None = None  # accepted, unused today (no multi-turn context yet)


class EvidenceChip(BaseModel):
    id: str
    label: str
    meeting_id: str
    meeting_title: str
    speaker: str
    timestamp_s: float
    keyframe_thumbnail_url: str | None = None


class ChatMessage(BaseModel):
    id: str
    role: str
    content: str
    evidence: list[EvidenceChip] | None = None
    created_at: str


class ChatResponse(BaseModel):
    message: ChatMessage


def _session_ids_for_meeting(db: Session, meeting_id: str) -> list[str]:
    return [
        row[0]
        for row in db.query(CaptureSession.id).filter(CaptureSession.meeting_id == meeting_id).all()
    ]


def _fts_candidates(
    db: Session, org_id: str, question: str, meeting_id: str | None
) -> list[KnowledgeItem]:
    """Postgres full-text search over statements — the working retrieval path today."""
    q = db.query(KnowledgeItem).filter(KnowledgeItem.org_id == org_id)
    if meeting_id:
        q = q.filter(KnowledgeItem.capture_session_id.in_(_session_ids_for_meeting(db, meeting_id)))

    dialect = db.bind.dialect.name if db.bind is not None else ""
    if dialect == "postgresql":
        tsvector = func.to_tsvector("english", KnowledgeItem.statement)
        tsquery = func.plainto_tsquery("english", question)
        q = q.filter(tsvector.op("@@")(tsquery)).order_by(func.ts_rank(tsvector, tsquery).desc())
    else:
        # Dev/test fallback (SQLite can't do to_tsvector): naive token ILIKE
        # match. Production always takes the postgresql branch above.
        tokens = [t for t in re.findall(r"[\w]+", question.lower()) if len(t) > 2]
        if not tokens:
            return []
        q = q.filter(or_(*[KnowledgeItem.statement.ilike(f"%{t}%") for t in tokens]))
    return q.limit(MAX_FTS_CANDIDATES).all()


def _vector_candidates(
    db: Session, org_id: str, query_embedding: list[float] | None, meeting_id: str | None
) -> list[KnowledgeItem]:
    """pgvector cosine-similarity search over `KnowledgeItem.embedding`.

    TODO: embedding population pending agents pipeline — no Embedder swap
    point exists yet, so callers always pass `query_embedding=None` today and
    this returns []. The query itself is wired correctly (pgvector cosine
    distance ordering, org/meeting scoped, embedding-not-null filtered) so it
    activates with zero changes here once a question embedding is available.
    """
    if query_embedding is None:
        return []
    if db.bind is None or db.bind.dialect.name != "postgresql":
        return []
    q = db.query(KnowledgeItem).filter(
        KnowledgeItem.org_id == org_id, KnowledgeItem.embedding.isnot(None)
    )
    if meeting_id:
        q = q.filter(KnowledgeItem.capture_session_id.in_(_session_ids_for_meeting(db, meeting_id)))
    q = q.order_by(KnowledgeItem.embedding.cosine_distance(query_embedding))
    return q.limit(MAX_VECTOR_CANDIDATES).all()


def _expand_edges(db: Session, items: list[KnowledgeItem]) -> list[KnowledgeItem]:
    """One-hop expansion along knowledge_edge (supersedes/contradicts/continues/recurs/resolves)."""
    if not items:
        return []
    ids = {i.id for i in items}
    edges = (
        db.query(KnowledgeEdge)
        .filter(or_(KnowledgeEdge.from_item_id.in_(ids), KnowledgeEdge.to_item_id.in_(ids)))
        .limit(MAX_EDGE_ROWS)
        .all()
    )
    related_ids = {e.from_item_id for e in edges} | {e.to_item_id for e in edges}
    related_ids -= ids
    if not related_ids:
        return []
    return db.query(KnowledgeItem).filter(KnowledgeItem.id.in_(related_ids)).all()


def _template_answer(
    question: str, matches: list[KnowledgeItem], related: list[KnowledgeItem]
) -> str:
    if not matches:
        return (
            f'No verified knowledge items matched "{question}" yet. '
            "Try rephrasing, or check back once more meetings have been processed."
        )
    lines = [f'Here is what verified knowledge says about "{question}":']
    for item in matches:
        lines.append(f"- [{item.type.value}] {item.statement} ({item.confidence.value})")
    if related:
        lines.append("")
        lines.append("Related items:")
        for item in related:
            lines.append(f"- [{item.type.value}] {item.statement}")
    return "\n".join(lines)


class _ChatAnswer(BaseModel):
    answer: str


CHAT_SYSTEM_PROMPT = (
    "You answer questions about an organization's meetings using ONLY the verified "
    "knowledge items given below — never raw transcript, never invented facts. "
    "Ground every claim in the given statements; if they don't answer the question, say so."
)


async def _llm_answer(
    llm: LlmClient, question: str, matches: list[KnowledgeItem], related: list[KnowledgeItem]
) -> str:
    lines = [f"QUESTION: {question}", "", "MATCHED KNOWLEDGE ITEMS:"]
    for item in matches:
        lines.append(
            f"- id={item.id} type={item.type.value} confidence={item.confidence.value}: {item.statement}"
        )
    if related:
        lines.append("")
        lines.append("RELATED ITEMS (via knowledge_edge, one hop):")
        for item in related:
            lines.append(f"- id={item.id} type={item.type.value}: {item.statement}")
    result, _usage = await llm.complete_structured(
        model="claude-sonnet-5",
        system=CHAT_SYSTEM_PROMPT,
        user_content="\n".join(lines),
        schema=_ChatAnswer,
    )
    return result.answer


async def _build_chip(
    db: Session, blob, item: KnowledgeItem, row: KnowledgeEvidence
) -> EvidenceChip | None:
    session = db.get(CaptureSession, item.capture_session_id)
    meeting = db.get(Meeting, session.meeting_id) if session else None
    meeting_title = meeting.title if meeting else "Unknown meeting"
    meeting_id = meeting.id if meeting else ""

    if row.utterance_id:
        utt = db.get(Utterance, row.utterance_id)
        if utt is None:
            return None
        speaker = "Unknown speaker"
        if utt.person_id:
            person = db.get(Person, utt.person_id)
            if person is not None:
                speaker = person.display_name
        minutes, seconds = divmod(int(utt.start_s), 60)
        return EvidenceChip(
            id=row.id,
            label=f"{speaker} — {meeting_title} @ {minutes:02d}:{seconds:02d}",
            meeting_id=meeting_id,
            meeting_title=meeting_title,
            speaker=speaker,
            timestamp_s=utt.start_s,
        )
    if row.keyframe_id:
        kf = db.get(Keyframe, row.keyframe_id)
        if kf is None:
            return None
        thumb = await blob.presigned_url(kf.image_uri) if kf.image_uri else None
        minutes, seconds = divmod(int(kf.valid_from_s), 60)
        return EvidenceChip(
            id=row.id,
            label=f"Screen — {meeting_title} @ {minutes:02d}:{seconds:02d}",
            meeting_id=meeting_id,
            meeting_title=meeting_title,
            speaker="Screen capture",
            timestamp_s=kf.valid_from_s,
            keyframe_thumbnail_url=thumb,
        )
    return None


def get_optional_llm_client() -> LlmClient | None:
    """No shared LlmClient factory exists outside the agents workstream yet.

    This endpoint is fully functional without one (`_template_answer` below).
    Override this dependency to inject a real `LlmClient` and this endpoint
    will call `complete_structured` instead — without ever importing
    `VertexLlmClient` here.
    """
    return None


@router.post("", response_model=ChatResponse)
async def chat(
    req: ChatRequest,
    db: Session = Depends(get_db),
    llm: LlmClient | None = Depends(get_optional_llm_client),
) -> ChatResponse:
    query_embedding: list[float] | None = None  # TODO: embedding population pending agents pipeline

    fts_matches = _fts_candidates(db, req.org_id, req.question, req.meeting_id)
    vector_matches = _vector_candidates(db, req.org_id, query_embedding, req.meeting_id)

    seen: set[str] = set()
    matches: list[KnowledgeItem] = []
    for item in [*fts_matches, *vector_matches]:
        if item.id not in seen:
            seen.add(item.id)
            matches.append(item)

    related = [item for item in _expand_edges(db, matches) if item.id not in seen]

    answer = (
        await _llm_answer(llm, req.question, matches, related)
        if llm is not None
        else _template_answer(req.question, matches, related)
    )

    blob = get_blobstore()
    evidence: list[EvidenceChip] = []
    for item in matches:
        rows = (
            db.query(KnowledgeEvidence)
            .filter(KnowledgeEvidence.knowledge_item_id == item.id)
            .limit(MAX_EVIDENCE_PER_ITEM)
            .all()
        )
        for row in rows:
            chip = await _build_chip(db, blob, item, row)
            if chip is not None:
                evidence.append(chip)

    message = ChatMessage(
        id=str(uuid.uuid4()),
        role="assistant",
        content=answer,
        evidence=evidence or None,
        created_at=datetime.now(UTC).isoformat(),
    )
    return ChatResponse(message=message)
