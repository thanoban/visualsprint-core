"""SQLAlchemy engine/session setup."""

from collections.abc import Generator

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings


class Base(DeclarativeBase):
    pass


_engine = None
_SessionLocal: sessionmaker[Session] | None = None


def get_engine() -> "Engine":
    global _engine
    if _engine is None:
        # Supabase free-tier session pooler hard-limits to 15 total connections
        # across ALL connecting clients. With max_instances=2 for both api and
        # agents, four engine instances can exist simultaneously:
        # 4 × (pool_size=3 + max_overflow=0) = 12, safely under the limit.
        # No overflow slots: a 4th concurrent query on the same instance waits
        # up to pool_timeout rather than opening a 4th connection that would
        # push the org-wide total over 15 during rolling deploys.
        # pool_pre_ping evicts stale connections after Cloud Run scale-to-zero.
        # pool_recycle prevents pgbouncer's idle-connection reaping from causing
        # "connection closed" errors on long-idle instances.
        _engine = create_engine(
            get_settings().database_url,
            pool_pre_ping=True,
            pool_size=3,
            max_overflow=0,
            pool_timeout=30,
            pool_recycle=300,
        )
    return _engine


def get_sessionmaker() -> sessionmaker[Session]:
    global _SessionLocal
    if _SessionLocal is None:
        _SessionLocal = sessionmaker(bind=get_engine(), expire_on_commit=False)
    return _SessionLocal


def get_db() -> Generator[Session, None, None]:
    """FastAPI dependency."""
    db = get_sessionmaker()()
    try:
        yield db
    finally:
        db.close()
