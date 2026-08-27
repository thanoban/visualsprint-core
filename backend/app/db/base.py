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
        # VS_DATABASE_URL uses Supabase's transaction-mode pooler (port 6543).
        # Transaction mode removes the 15-connection cap that the session-mode
        # pooler (port 5432) imposed, and is safe here because we never use
        # connection-level state (no advisory locks, no SET statements that
        # persist across requests, no prepared-statement caching).
        # pool_size=3 per instance: pgbouncer only holds a backend connection
        # for the duration of a transaction, so 3 SQLAlchemy "connections" can
        # comfortably multiplex across the pool without exhausting the server.
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
