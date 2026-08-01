"""Gmail draft connector — ActionKind.EMAIL_DRAFT.

Creates a DRAFT via `users.drafts.create`; never sends. Gmail OAuth is not yet
configured (docs/03-capture.md's token-provider pattern applies here too), so
this depends only on the `TokenProvider` Protocol — wiring a real
GoogleOAuthTokenProvider is a follow-up with no connector code changes.

`ActionPayload.target` fields used: "to" (required, comma-separated addresses),
"cc" (optional, comma-separated).
"""

import base64
from email.mime.text import MIMEText

import httpx

from app.capture.token_provider import TokenProvider
from app.connectors.errors import ConnectorError
from app.interfaces.actions import ActionKind, ActionPayload, ActionResult

GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1"


class EmailDraftConnector:
    kind = ActionKind.EMAIL_DRAFT

    def __init__(
        self,
        *,
        token_provider: TokenProvider,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._tokens = token_provider
        self._client = http_client or httpx.AsyncClient()

    async def execute(self, payload: ActionPayload) -> ActionResult:
        to = payload.target.get("to")
        if not to:
            raise ConnectorError("email_draft target requires 'to'")

        raw = self._build_raw_message(payload, to)
        token = await self._tokens.get_token()

        resp = await self._client.post(
            f"{GMAIL_API_BASE}/users/me/drafts",
            headers={"Authorization": f"Bearer {token}"},
            json={"message": {"raw": raw}},
        )
        if resp.status_code >= 400:
            raise ConnectorError(f"Gmail draft creation failed ({resp.status_code}): {resp.text}")

        data = resp.json()
        draft_id = data.get("id")
        message_id = data.get("message", {}).get("id")
        return ActionResult(
            external_id=draft_id,
            external_url=(
                f"https://mail.google.com/mail/u/0/#drafts?compose={message_id}"
                if message_id
                else None
            ),
            detail=f"Gmail draft created for {to}",
        )

    def _build_raw_message(self, payload: ActionPayload, to: str) -> str:
        msg = MIMEText(payload.body)
        msg["To"] = to
        cc = payload.target.get("cc")
        if cc:
            msg["Cc"] = cc
        msg["Subject"] = payload.title
        return base64.urlsafe_b64encode(msg.as_bytes()).decode("ascii")
