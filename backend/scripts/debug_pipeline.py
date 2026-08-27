"""Debug and smoke-test harness for the VisualSprint pipeline.

Run from backend/ with:

  python -m scripts.debug_pipeline <command> [args]

Commands
--------
  gemini-test                      Verify Gemini on Vertex AI is reachable
  embed-test                       Verify gemini-embedding-001 embedder (us-central1)
  list-sessions                    Show all CaptureSession rows and their pipeline state
  show-session <session_id>        Show all PipelineJob rows for one session
  run-stage <session_id> <stage>   Run one pipeline stage for a session (idempotent)

Environment required for GCP commands (same as production):
  GOOGLE_APPLICATION_CREDENTIALS  path to service-account key file, OR
  gcloud auth application-default login already run

Optional:
  VS_VERTEX_PROJECT_ID   override GCP project (falls back to ADC default)
  VS_GEMINI_REGION       override region (default: us-central1)

Example end-to-end local test after `docker compose up -d db` and
`alembic upgrade head`:

  # 1. Upload via the API (copy session_id from response)
  # 2. python -m scripts.debug_pipeline list-sessions
  # 3. python -m scripts.debug_pipeline run-stage <id> acquire
  # 4. python -m scripts.debug_pipeline run-stage <id> diarize
  # 5. ... repeat for each stage through report
  # 6. python -m scripts.debug_pipeline show-session <id>
"""

from __future__ import annotations

import asyncio
import sys
import uuid
from datetime import UTC, datetime

import structlog

structlog.configure(
    processors=[
        structlog.stdlib.add_log_level,
        structlog.dev.ConsoleRenderer(),
    ]
)

log = structlog.get_logger()


def _db_session():
    from app.db.base import get_sessionmaker

    maker = get_sessionmaker()
    return maker()


# ---------------------------------------------------------------------------
# gemini-test
# ---------------------------------------------------------------------------


async def cmd_gemini_test():
    from app.orchestrator.worker import _get_llm

    log.info("gemini.test.start")
    llm = _get_llm()

    from app.interfaces.llm import LlmUsage
    from pydantic import BaseModel

    class Ping(BaseModel):
        reply: str
        timestamp: str

    prompt = (
        "Reply with JSON matching the schema: "
        '{"reply": "pong", "timestamp": "<current UTC ISO timestamp>"}'
    )

    result, usage = await llm.complete_structured(
        system="You are a ping responder. Reply only with valid JSON.",
        user_content=prompt,
        schema=Ping,
        model="gemini-2.5-flash-lite",
    )
    log.info("gemini.test.ok", reply=result.reply, timestamp=result.timestamp, usage=str(usage))
    print("\n[OK] Gemini on Vertex AI is working.")
    print(f"  reply     = {result.reply}")
    print(f"  timestamp = {result.timestamp}")
    print(f"  tokens    = {usage}")


# ---------------------------------------------------------------------------
# embed-test
# ---------------------------------------------------------------------------


async def cmd_embed_test():
    from app.adapters.embedder_vertex import EMBEDDING_DIMENSIONALITY, VertexEmbedder

    log.info("embed.test.start")
    embedder = VertexEmbedder()
    vec = await embedder.embed("VisualSprint meeting intelligence smoke test")
    if len(vec) != EMBEDDING_DIMENSIONALITY:
        log.error("embed.test.fail", got=len(vec), expected=EMBEDDING_DIMENSIONALITY)
        sys.exit(1)
    log.info(
        "embed.test.ok",
        dims=len(vec),
        first5=[round(v, 4) for v in vec[:5]],
    )
    print(f"\n[OK] gemini-embedding-001 returned {len(vec)}-dim vector.")


# ---------------------------------------------------------------------------
# list-sessions
# ---------------------------------------------------------------------------


def cmd_list_sessions():
    from sqlalchemy import select

    from app.db.models import CaptureSession, PipelineJob

    db = _db_session()
    try:
        sessions = db.scalars(select(CaptureSession).order_by(CaptureSession.created_at.desc())).all()
        if not sessions:
            print("No CaptureSession rows found.")
            return

        print(f"\n{'ID':<38} {'State':<15} {'Created':<26} {'Title'}")
        print("-" * 100)
        for s in sessions:
            created = s.created_at.strftime("%Y-%m-%d %H:%M:%S") if s.created_at else "—"
            title = (s.report_title or s.title or "—")[:40]
            print(f"{str(s.id):<38} {s.state:<15} {created:<26} {title}")

        print(f"\n{len(sessions)} session(s) total.")

        # Show latest PipelineJob states
        print("\nPipeline job states (latest session first):")
        for s in sessions[:5]:
            jobs = db.scalars(
                select(PipelineJob)
                .where(PipelineJob.capture_session_id == s.id)
                .order_by(PipelineJob.created_at)
            ).all()
            if jobs:
                stages = " → ".join(f"{j.stage}:{j.state}" for j in jobs)
                print(f"  {str(s.id)[:8]}…  {stages}")
    finally:
        db.close()


# ---------------------------------------------------------------------------
# show-session
# ---------------------------------------------------------------------------


def cmd_show_session(session_id: str):
    from sqlalchemy import select

    from app.db.models import CaptureSession, PipelineJob, KnowledgeItem

    db = _db_session()
    try:
        sid = uuid.UUID(session_id)
        session = db.get(CaptureSession, sid)
        if not session:
            print(f"Session {session_id} not found.")
            sys.exit(1)

        print(f"\nSession: {session_id}")
        print(f"  State:   {session.state}")
        print(f"  Title:   {session.report_title or session.title or '—'}")
        print(f"  Created: {session.created_at}")

        jobs = db.scalars(
            select(PipelineJob)
            .where(PipelineJob.capture_session_id == sid)
            .order_by(PipelineJob.created_at)
        ).all()

        print(f"\nPipeline jobs ({len(jobs)}):")
        for j in jobs:
            err = f" ERROR: {j.last_error[:60]}" if j.last_error else ""
            print(f"  {j.stage:<12} {j.state:<10} attempts={j.attempts}{err}")

        items = db.execute(
            select(KnowledgeItem.__table__.c.type, KnowledgeItem.__table__.c.confidence)
            .where(KnowledgeItem.__table__.c.capture_session_id == sid)
        ).all()
        if items:
            from collections import Counter
            counts = Counter((r.type, r.confidence) for r in items)
            print(f"\nKnowledgeItems ({len(items)}):")
            for (t, c), n in sorted(counts.items()):
                print(f"  {t:<20} {c:<20} x{n}")
    finally:
        db.close()


# ---------------------------------------------------------------------------
# run-stage
# ---------------------------------------------------------------------------


async def cmd_run_stage(session_id: str, stage: str):
    from sqlalchemy import select

    from app.db.models import CaptureSession, PipelineJob
    from app.orchestrator.worker import _HANDLERS

    if stage not in _HANDLERS:
        print(f"Unknown stage '{stage}'. Valid stages: {', '.join(_HANDLERS)}")
        sys.exit(1)

    db = _db_session()
    try:
        sid = uuid.UUID(session_id)
        session = db.get(CaptureSession, sid)
        if not session:
            print(f"Session {session_id} not found.")
            sys.exit(1)

        # Find or create a PipelineJob for this stage
        job = db.scalars(
            select(PipelineJob)
            .where(
                PipelineJob.capture_session_id == sid,
                PipelineJob.stage == stage,
            )
        ).first()

        if not job:
            job = PipelineJob(
                capture_session_id=sid,
                org_id=session.org_id,
                stage=stage,
                state="PENDING",
                attempts=0,
            )
            db.add(job)
            db.commit()
            db.refresh(job)
            log.info("run_stage.job_created", stage=stage, job_id=str(job.id))
        else:
            log.info("run_stage.job_found", stage=stage, state=job.state, job_id=str(job.id))

        log.info("run_stage.start", stage=stage, session=session_id)
        handler = _HANDLERS[stage]
        try:
            await handler(db, job)
            log.info("run_stage.ok", stage=stage)
            print(f"\n[OK] Stage '{stage}' completed successfully.")
        except Exception as exc:
            log.exception("run_stage.fail", stage=stage, error=str(exc))
            print(f"\n[FAIL] Stage '{stage}' failed: {exc}")
            sys.exit(1)
    finally:
        db.close()


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(0)

    cmd = args[0]

    if cmd == "gemini-test":
        asyncio.run(cmd_gemini_test())
    elif cmd == "embed-test":
        asyncio.run(cmd_embed_test())
    elif cmd == "list-sessions":
        cmd_list_sessions()
    elif cmd == "show-session":
        if len(args) < 2:
            print("Usage: show-session <session_id>")
            sys.exit(1)
        cmd_show_session(args[1])
    elif cmd == "run-stage":
        if len(args) < 3:
            print("Usage: run-stage <session_id> <stage>")
            sys.exit(1)
        asyncio.run(cmd_run_stage(args[1], args[2]))
    else:
        print(f"Unknown command: {cmd}")
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
