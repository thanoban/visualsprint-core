"""SecretStore swap point — durable storage for small secret values (OAuth
access/refresh tokens, resolved API keys) that must never live in a
regular DB column. `CalendarConnection.secret_ref` (and any future
per-org OAuth connection row) stores a *name* here, not the secret
itself — see that model's own comment on why.

Values are opaque strings; a caller storing structured data (e.g. an
OAuth token pair) serializes it itself (see app/oauth/token_provider.py)
rather than this interface knowing about token shapes. Local dev writes
plaintext to disk (matching every other local adapter in this codebase —
LocalBlobStore is also plaintext-on-disk); real security comes from the
production implementation, GCP Secret Manager
(app/adapters/secretstore_gcp.py).
"""

from typing import Protocol


class SecretStore(Protocol):
    async def put(self, name: str, value: str) -> None:
        """Create the secret at `name`, or overwrite it if it already
        exists (e.g. storing a refreshed OAuth token)."""
        ...

    async def get(self, name: str) -> str:
        """Raises KeyError if `name` doesn't exist — callers must not
        treat a missing secret as an empty string, that would silently
        authenticate with nothing."""
        ...

    async def delete(self, name: str) -> None:
        """Idempotent: deleting an already-absent secret must not raise."""
        ...
