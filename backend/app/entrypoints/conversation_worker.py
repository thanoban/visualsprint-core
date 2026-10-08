"""Saved-chat worker. Run with --watch on a separately supervised worker host."""

import argparse
import asyncio
import uuid
from collections.abc import Callable
from contextlib import suppress
from typing import cast

from sqlalchemy.orm import Session

from app.bootstrap import make_llm
from app.db.base import get_sessionmaker
from app.modules.conversations.jobs import generate_next


async def run(*, watch: bool) -> None:
    sessions = cast(Callable[[], Session], get_sessionmaker())
    worker = f"chat-{uuid.uuid4()}"
    while True:
        worked = await generate_next(sessions, llm_factory=make_llm, worker_id=worker)
        if not worked:
            if not watch:
                return
            await asyncio.sleep(2)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--watch", action="store_true")
    args = parser.parse_args()
    with suppress(KeyboardInterrupt):
        asyncio.run(run(watch=args.watch))


if __name__ == "__main__":
    main()
