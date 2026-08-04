"""Commitment reminder connector — ActionKind.REMINDER.

docs/PROJECT_PLAN.md's automation table: triggered when a commitment's due
date is approaching and it's still open, target is an "owner DM draft".
Structurally that's a draft written to one person -- the same operation
EmailDraftConnector already performs (Gmail drafts.create, never send) --
so this delegates rather than re-implementing draft creation.
`ActionPayload.target` fields are identical: "to" (the owner's address).
"""

import httpx

from app.capture.token_provider import TokenProvider
from app.connectors.email_draft import EmailDraftConnector
from app.interfaces.actions import ActionKind, ActionPayload, ActionResult


class ReminderConnector:
    kind = ActionKind.REMINDER

    def __init__(
        self,
        *,
        token_provider: TokenProvider,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._delegate = EmailDraftConnector(token_provider=token_provider, http_client=http_client)

    async def execute(self, payload: ActionPayload) -> ActionResult:
        return await self._delegate.execute(payload)
