"""GCP Secret Manager-backed SecretStore — production. Same GCP project as
Vertex AI / Google Speech-to-Text (app.config.Settings.vertex_project_id),
so one set of Application Default Credentials covers all three.

Lazy-loaded client, injectable via constructor — same pattern as every
other vendor-backed adapter in this codebase (S3BlobStore, PaddleOCR,
pyannote): tests inject a fake client and never trigger the real
google-cloud-secret-manager import, so this file is fully testable without
that package installed.

Secret Manager has no "overwrite" — a secret is created once, then each
update adds a new version; reads always fetch "latest". `delete` removes
the secret and every version, not just the latest one.
"""

import asyncio
import re
from typing import Any, Protocol

from google.auth import default as google_auth_default

from app.config import get_settings

SCHEME = "gcpsm://"

_INVALID_ID_CHARS = re.compile(r"[^a-zA-Z0-9_-]")


def _sanitize_secret_id(name: str) -> str:
    """GCP Secret Manager secret ids only allow [a-zA-Z0-9_-] — our own
    names (e.g. "oauth/google/<uuid>") can contain slashes, so this maps
    them into that charset. Deterministic, not reversible -- callers only
    ever need to look a name back up by the same string they stored it
    under, never to recover the original from the sanitized id."""
    return _INVALID_ID_CHARS.sub("_", name)


class SecretManagerClientBackend(Protocol):
    """Subset of google.cloud.secretmanager's client this adapter uses."""

    def create_secret(self, request: dict) -> Any: ...
    def add_secret_version(self, request: dict) -> Any: ...
    def access_secret_version(self, request: dict) -> Any: ...
    def delete_secret(self, request: dict) -> Any: ...


def _resolve_project_id(explicit: str | None) -> str:
    if explicit:
        return explicit
    _, project_id = google_auth_default()
    if not project_id:
        raise RuntimeError(
            "vertex_project_id not set and no default GCP project found via "
            "Application Default Credentials"
        )
    return project_id


def _build_client() -> SecretManagerClientBackend:
    from google.cloud import secretmanager

    return secretmanager.SecretManagerServiceClient()


class GcpSecretStore:
    """`SecretStore` Protocol implementation over GCP Secret Manager."""

    def __init__(
        self, client: SecretManagerClientBackend | None = None, project_id: str | None = None
    ) -> None:
        settings = get_settings()
        self._project_id = _resolve_project_id(project_id or settings.vertex_project_id)
        self._client = client

    def _ensure_client(self) -> SecretManagerClientBackend:
        if self._client is None:
            self._client = _build_client()
        return self._client

    def _secret_path(self, secret_id: str) -> str:
        return f"projects/{self._project_id}/secrets/{secret_id}"

    async def put(self, name: str, value: str) -> None:
        secret_id = _sanitize_secret_id(name)
        client = self._ensure_client()

        def _create_if_missing() -> None:
            try:
                client.create_secret(
                    request={
                        "parent": f"projects/{self._project_id}",
                        "secret_id": secret_id,
                        "secret": {"replication": {"automatic": {}}},
                    }
                )
            except Exception as exc:
                # AlreadyExists on a repeat put() for the same name is
                # expected -- this is the "overwrite" path, handled below
                # by adding a new version. Anything else must not be
                # swallowed as if the secret were already there correctly.
                if "already exists" not in str(exc).lower():
                    raise

        await asyncio.to_thread(_create_if_missing)
        await asyncio.to_thread(
            client.add_secret_version,
            request={
                "parent": self._secret_path(secret_id),
                "payload": {"data": value.encode("utf-8")},
            },
        )

    async def get(self, name: str) -> str:
        secret_id = _sanitize_secret_id(name)
        client = self._ensure_client()
        try:
            response = await asyncio.to_thread(
                client.access_secret_version,
                request={"name": f"{self._secret_path(secret_id)}/versions/latest"},
            )
        except Exception as exc:
            if "not found" in str(exc).lower():
                raise KeyError(f"secret not found: {name!r}") from exc
            raise
        return response.payload.data.decode("utf-8")

    async def delete(self, name: str) -> None:
        secret_id = _sanitize_secret_id(name)
        client = self._ensure_client()
        try:
            await asyncio.to_thread(
                client.delete_secret, request={"name": self._secret_path(secret_id)}
            )
        except Exception as exc:
            if "not found" not in str(exc).lower():
                raise


def get_secretstore():
    """Factory honouring settings.secretstore_backend."""
    from app.adapters.secretstore_local import LocalSecretStore

    s = get_settings()
    if s.secretstore_backend == "gcp":
        return GcpSecretStore()
    return LocalSecretStore()
