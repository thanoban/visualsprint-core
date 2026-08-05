"""Local-filesystem SecretStore for dev. Prod uses GCP Secret Manager
(secretstore_gcp.py). Plaintext on disk -- same "local=dev convenience,
not production security" stance as LocalBlobStore. Never point this at a
real OAuth app's client secret or a real customer's tokens outside a
throwaway dev environment.
"""

from pathlib import Path

from app.config import get_settings


class LocalSecretStore:
    def __init__(self, root: str | None = None) -> None:
        self.root = Path(root or get_settings().secretstore_local_dir)
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, name: str) -> Path:
        # Secret names are our own generated ids (e.g. "oauth/<uuid>"), but
        # validate anyway -- a path-escaping name must never turn into an
        # arbitrary filesystem write/read.
        if not name or ".." in name:
            raise ValueError(f"invalid secret name: {name!r}")
        p = (self.root / f"{name}.secret").resolve()
        if not p.is_relative_to(self.root.resolve()):
            raise ValueError("path escape rejected")
        return p

    async def put(self, name: str, value: str) -> None:
        p = self._path(name)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(value, encoding="utf-8")

    async def get(self, name: str) -> str:
        p = self._path(name)
        if not p.exists():
            raise KeyError(f"secret not found: {name!r}")
        return p.read_text(encoding="utf-8")

    async def delete(self, name: str) -> None:
        self._path(name).unlink(missing_ok=True)
