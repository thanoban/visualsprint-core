"""OAuthTokenProvider -- the `TokenProvider` Protocol implementation for a
real per-connection OAuth grant, once one exists (app/oauth/flow.py's
authorize/callback routes did the authorization; this is what every
adapter/connector calls at request time to get a bearer token).

Resolves the stored OAuthTokenSet from SecretStore by `secret_ref`,
returns the cached access_token if still valid, refreshes it via the
vendor's token endpoint if expired -- writing the refreshed token set
back to SecretStore so the next call doesn't refresh again -- and raises
loudly if there's no refresh_token to fall back on. A dead grant must
surface as a clear "needs re-authorization" error, not silently hand
downstream code a token that will fail with an opaque 401.
"""

from datetime import UTC, datetime, timedelta

import httpx

from app.interfaces.secretstore import SecretStore
from app.oauth.flow import OAuthTokenSet, refresh_access_token
from app.oauth.providers import OAuthProviderConfig

# Refresh a little before actual expiry, not exactly at it -- avoids a
# request racing the token's last valid second.
EXPIRY_BUFFER_SECONDS = 60


class OAuthTokenProvider:
    def __init__(
        self,
        *,
        secret_ref: str,
        provider_config: OAuthProviderConfig,
        secret_store: SecretStore,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._secret_ref = secret_ref
        self._config = provider_config
        self._secrets = secret_store
        self._client = http_client or httpx.AsyncClient()

    async def get_token(self) -> str:
        token_set = await self._load()
        if self._is_expired(token_set):
            token_set = await self._refresh(token_set)
        return token_set.access_token

    async def _load(self) -> OAuthTokenSet:
        raw = await self._secrets.get(self._secret_ref)
        return OAuthTokenSet.model_validate_json(raw)

    def _is_expired(self, token_set: OAuthTokenSet) -> bool:
        if token_set.expires_at is None:
            return False
        return datetime.now(UTC) >= token_set.expires_at - timedelta(seconds=EXPIRY_BUFFER_SECONDS)

    async def _refresh(self, token_set: OAuthTokenSet) -> OAuthTokenSet:
        if token_set.refresh_token is None:
            raise RuntimeError(
                f"OAuth token for {self._secret_ref!r} expired and has no refresh_token -- "
                "the connection needs to be re-authorized"
            )
        refreshed = await refresh_access_token(
            self._config, refresh_token=token_set.refresh_token, http_client=self._client
        )
        await self._secrets.put(self._secret_ref, refreshed.model_dump_json())
        return refreshed
