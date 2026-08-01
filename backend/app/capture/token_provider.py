"""TokenProvider swap point for capture adapters.

Neither the Google Workspace Marketplace app (Meet) nor the Zoom Server-to-Server
OAuth app is registered yet, so real token acquisition can't be implemented today.
Adapters depend only on this Protocol and are fully testable against it; wiring in
GoogleOAuthTokenProvider / ZoomS2SOAuthTokenProvider is a follow-up once credentials
exist — no adapter code changes when that happens.
"""

from typing import Protocol


class TokenProvider(Protocol):
    async def get_token(self) -> str:
        """Return a valid bearer token, refreshing internally if the cached one expired."""
        ...


class StaticTokenProvider:
    """Wraps a fixed token string. Used by tests and for short-lived manual tokens."""

    def __init__(self, token: str) -> None:
        self._token = token

    async def get_token(self) -> str:
        return self._token


class UnconfiguredTokenProvider:
    """Default until real OAuth apps are registered. Fails loudly rather than
    silently shipping an empty/invalid Authorization header."""

    def __init__(self, reason: str = "OAuth app not yet registered") -> None:
        self._reason = reason

    async def get_token(self) -> str:
        raise RuntimeError(f"TokenProvider not configured: {self._reason}")
