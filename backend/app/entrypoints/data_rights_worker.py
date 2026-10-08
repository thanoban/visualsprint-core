"""Bounded data-rights outbox worker. No production data is touched by importing it."""

import argparse
import asyncio
import uuid
from collections.abc import Callable
from contextlib import suppress
from typing import cast

from sqlalchemy.orm import Session

from app.adapters.blobstore_s3 import get_blobstore
from app.adapters.secretstore_gcp import get_secretstore
from app.capture.provider_resolver import VexaProviderResolver
from app.db.base import get_sessionmaker
from app.interfaces.secretstore import SecretStore
from app.modules.data_rights.deletions import delete_next
from app.modules.data_rights.exports import export_next


async def run(*, watch: bool) -> None:
    sessions = cast(Callable[[], Session], get_sessionmaker())
    worker = f"rights-{uuid.uuid4()}"
    secrets = cast(Callable[[], SecretStore], get_secretstore)()
    blobs = get_blobstore()
    while True:
        worked = export_next(sessions, worker_id=worker)
        worked = (
            await delete_next(
                sessions,
                worker_id=worker,
                blob_store=blobs,
                secret_store=secrets,
                provider_resolver=VexaProviderResolver(secrets),
            )
            or worked
        )
        if not worked:
            if not watch:
                return
            await asyncio.sleep(5)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--watch", action="store_true")
    args = parser.parse_args()
    with suppress(KeyboardInterrupt):
        asyncio.run(run(watch=args.watch))


if __name__ == "__main__":
    main()
