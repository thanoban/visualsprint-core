"""Bounded entrypoint for durable capture dispatch and reconciliation."""

import asyncio
import json
from collections.abc import Callable
from typing import cast

from sqlalchemy.orm import Session

from app.adapters.secretstore_gcp import get_secretstore
from app.capture.dispatcher import dispatch_next
from app.capture.provider_resolver import VexaProviderResolver
from app.capture.reconciler import reconcile_next
from app.capture.transcript_bridge import ingest_next
from app.db.base import get_sessionmaker
from app.interfaces.secretstore import SecretStore


async def run_capture_pass(
    *,
    session_factory: Callable[[], Session] | None = None,
    secret_store: SecretStore | None = None,
    worker_id: str = "capture-worker",
    max_events: int = 20,
) -> dict[str, int]:
    if not 1 <= max_events <= 1000:
        raise ValueError("max_events must be between 1 and 1000")
    sessions = session_factory or cast(Callable[[], Session], get_sessionmaker())
    secrets = secret_store or cast(Callable[[], SecretStore], get_secretstore)()
    resolver = VexaProviderResolver(secrets)
    dispatched = reconciled = ingested = 0
    for _ in range(max_events):
        did_dispatch = await dispatch_next(
            sessions,
            secret_store=secrets,
            provider_resolver=resolver,
            worker_id=worker_id,
        )
        did_reconcile = await reconcile_next(
            sessions,
            provider_resolver=resolver,
            worker_id=worker_id,
        )
        did_ingest = await ingest_next(
            sessions,
            provider_resolver=resolver,
            worker_id=worker_id,
        )
        dispatched += int(did_dispatch)
        reconciled += int(did_reconcile)
        ingested += int(did_ingest)
        if not did_dispatch and not did_reconcile and not did_ingest:
            break
    return {
        "dispatch_events": dispatched,
        "reconcile_events": reconciled,
        "ingest_events": ingested,
    }


def main() -> None:
    result = asyncio.run(run_capture_pass())
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
