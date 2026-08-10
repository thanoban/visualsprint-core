from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool, text

from app.config import get_settings
from app.db.base import Base
from app.db import models  # noqa: F401 — register all tables on Base.metadata

config = context.config
# set_main_option stores the value through configparser's interpolation,
# where a bare "%" is special syntax (e.g. "%(foo)s") -- a real password
# containing a URL-encoded character like "%40" (for "@") raises
# "invalid interpolation syntax" before the connection is ever attempted.
# Doubling "%" here escapes it for configparser's storage; get_main_option/
# get_section decode it symmetrically on read, so the URL comes back out
# exactly as it went in.
config.set_main_option("sqlalchemy.url", get_settings().database_url.replace("%", "%%"))

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        # pgvector must exist before any Vector column migration runs
        connection.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        connection.commit()
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
