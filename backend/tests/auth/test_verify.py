"""Unit coverage for app.auth.verify -- Supabase JWT verification. Generates
a real ES256 key pair with the `cryptography` library (already pulled in by
pyjwt[crypto]) and signs test tokens with it, then injects a fake JWKS
client that returns the matching public key -- no network call to a real
Supabase project needed to test this."""

from types import SimpleNamespace

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec

import app.auth.verify as verify_module
from app.auth.verify import AuthError, verify_jwt

_PRIVATE_KEY = ec.generate_private_key(ec.SECP256R1())
_PUBLIC_KEY = _PRIVATE_KEY.public_key()


def _make_token(claims: dict) -> str:
    return jwt.encode(claims, _PRIVATE_KEY, algorithm="ES256")


class _FakeJwksClient:
    def get_signing_key_from_jwt(self, token: str):
        return SimpleNamespace(key=_PUBLIC_KEY)


@pytest.fixture(autouse=True)
def _fake_jwks(monkeypatch):
    monkeypatch.setattr(verify_module, "_jwks_client", _FakeJwksClient())
    yield
    monkeypatch.setattr(verify_module, "_jwks_client", None)


def test_verifies_a_valid_token_and_returns_its_claims():
    token = _make_token({"sub": "user-123", "email": "nimal@acme.com", "aud": "authenticated"})

    claims = verify_jwt(token)

    assert claims["sub"] == "user-123"
    assert claims["email"] == "nimal@acme.com"


def test_rejects_a_token_with_the_wrong_audience():
    token = _make_token({"sub": "user-123", "aud": "some-other-service"})

    with pytest.raises(AuthError, match="invalid token"):
        verify_jwt(token)


def test_rejects_a_token_missing_the_sub_claim():
    token = _make_token({"email": "nimal@acme.com", "aud": "authenticated"})

    with pytest.raises(AuthError, match="missing 'sub'"):
        verify_jwt(token)


def test_rejects_a_malformed_token():
    with pytest.raises(AuthError, match="invalid token"):
        verify_jwt("not-a-real-jwt")


def test_rejects_a_token_signed_with_a_different_key():
    other_private_key = ec.generate_private_key(ec.SECP256R1())
    token = jwt.encode(
        {"sub": "user-123", "aud": "authenticated"}, other_private_key, algorithm="ES256"
    )

    with pytest.raises(AuthError, match="invalid token"):
        verify_jwt(token)
