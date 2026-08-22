"""Supabase Auth JWT verification.

New Supabase projects (since Oct 2025) sign JWTs asymmetrically (ES256) and
publish the public keys at a per-project JWKS endpoint, rather than a single
shared secret — this module verifies against that endpoint via PyJWT's
`PyJWKClient`, never a static secret. `PyJWKClient` caches keys internally
and re-fetches on an unknown `kid`, so key rotation on Supabase's side needs
no deploy here.

Every Supabase Auth JWT carries `aud: "authenticated"` for a logged-in user
session; requiring it rejects tokens issued for another purpose that happen
to be signed by the same project.
"""

from typing import cast

import jwt
from jwt import PyJWKClient

from app.config import get_settings

_AUDIENCE = "authenticated"

_jwks_client: PyJWKClient | None = None


class AuthError(Exception):
    """Raised on a missing/invalid/expired token — never a bare PyJWT
    exception past this boundary, same convention as this codebase's other
    vendor-facing adapters (VendorTranscriptionError, OAuthTokenExchangeError)."""


def _get_jwks_client() -> PyJWKClient:
    global _jwks_client
    if _jwks_client is None:
        settings = get_settings()
        if not settings.supabase_url:
            raise AuthError("supabase_url not configured (VS_SUPABASE_URL)")
        _jwks_client = PyJWKClient(f"{settings.supabase_url}/auth/v1/.well-known/jwks.json")
    return _jwks_client


def verify_jwt(token: str) -> dict[str, object]:
    """Returns the verified claims dict (`sub`, `email`, ...) or raises AuthError."""
    try:
        signing_key = _get_jwks_client().get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["ES256"],
            audience=_AUDIENCE,
        )
    except AuthError:
        raise
    except jwt.PyJWTError as exc:
        raise AuthError(f"invalid token: {exc}") from exc
    if "sub" not in claims:
        raise AuthError("token missing 'sub' claim")
    return cast(dict[str, object], claims)
