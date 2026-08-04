"""Blocker escalation connector — ActionKind.ESCALATION.

docs/PROJECT_PLAN.md's automation table: triggered when a blocker is marked
RECURRING across >= N meetings, target is a "configurable notification".
Structurally that's the same operation as ChannelRecapConnector already
does (post a message to Slack/Teams) -- delegating avoids re-implementing
Slack bot-token vs. webhook dispatch and Teams webhook posting a second
time. `ActionPayload.target` fields are identical: "provider" (slack/teams),
"webhook_url" or "channel".
"""

import httpx

from app.capture.token_provider import TokenProvider
from app.connectors.channel_recap import ChannelRecapConnector
from app.interfaces.actions import ActionKind, ActionPayload, ActionResult


class EscalationConnector:
    kind = ActionKind.ESCALATION

    def __init__(
        self,
        *,
        slack_token_provider: TokenProvider | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._delegate = ChannelRecapConnector(
            slack_token_provider=slack_token_provider, http_client=http_client
        )

    async def execute(self, payload: ActionPayload) -> ActionResult:
        return await self._delegate.execute(payload)
