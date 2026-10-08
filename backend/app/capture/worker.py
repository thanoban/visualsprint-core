"""Bounded entrypoint for durable capture dispatch and reconciliation."""

import argparse
import asyncio
import json
import uuid
from collections.abc import Callable
from contextlib import suppress
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


async def serve(*, watch: bool, interval: float, max_events: int) -> None:
    worker_id = f"capture-{uuid.uuid4()}"
    while True:
        result = await run_capture_pass(worker_id=worker_id, max_events=max_events)
        if any(result.values()) or not watch:
            print(json.dumps(result, sort_keys=True), flush=True)
        if not watch:
            return
        await asyncio.sleep(interval)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--watch", action="store_true", help="Run continuously; requires meeting-lifetime hosting"
    )
    parser.add_argument("--interval", type=float, default=5)
    parser.add_argument("--max-events", type=int, default=20)
    args = parser.parse_args()
    if not 1 <= args.interval <= 60:
        parser.error("interval must be between 1 and 60 seconds")
    with suppress(KeyboardInterrupt):
        asyncio.run(serve(watch=args.watch, interval=args.interval, max_events=args.max_events))


if __name__ == "__main__":
    main()
