"""Slack/Teams recap connector — ActionKind.CHANNEL_RECAP.

Dispatches on `ActionPayload.target["provider"]` (`"slack"` or `"teams"`).

Slack: posts via Incoming Webhook (`target["webhook_url"]`) when present,
otherwise via `chat.postMessage` with a bot token (`target["channel"]` +
injected `slack_token_provider`).

Teams: Incoming Webhook only (`target["webhook_url"]`) — Teams has no
bot-token posting API comparable to Slack's without a full app registration.
"""

import httpx

from app.capture.token_provider import TokenProvider
from app.connectors.errors import ConnectorError, ConnectorNotConfiguredError
from app.interfaces.actions import ActionKind, ActionPayload, ActionResult

SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage"


class ChannelRecapConnector:
    kind = ActionKind.CHANNEL_RECAP

    def __init__(
        self,
        *,
        slack_token_provider: TokenProvider | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._slack_tokens = slack_token_provider
        self._client = http_client or httpx.AsyncClient()

    async def execute(self, payload: ActionPayload) -> ActionResult:
        provider = payload.target.get("provider")
        if provider == "slack":
            return await self._post_slack(payload)
        if provider == "teams":
            return await self._post_teams(payload)
        raise ConnectorError(f"unsupported channel_recap provider: {provider!r}")

    async def _post_slack(self, payload: ActionPayload) -> ActionResult:
        text = f"*{payload.title}*\n{payload.body}"
        webhook_url = payload.target.get("webhook_url")
        if webhook_url:
            resp = await self._client.post(webhook_url, json={"text": text})
            if resp.status_code >= 400 or resp.text.strip() != "ok":
                raise ConnectorError(f"Slack webhook post failed ({resp.status_code}): {resp.text}")
            return ActionResult(detail="Posted to Slack via incoming webhook")

        channel = payload.target.get("channel")
        if not channel:
            raise ConnectorError("slack channel_recap requires 'webhook_url' or 'channel'")
        if self._slack_tokens is None:
            raise ConnectorNotConfiguredError("no slack_token_provider configured for bot posting")

        token = await self._slack_tokens.get_token()
        resp = await self._client.post(
            SLACK_POST_MESSAGE_URL,
            headers={"Authorization": f"Bearer {token}"},
            json={"channel": channel, "text": text},
        )
        if resp.status_code >= 400:
            raise ConnectorError(f"Slack chat.postMessage failed ({resp.status_code}): {resp.text}")
        data = resp.json()
        if not data.get("ok"):
            raise ConnectorError(f"Slack chat.postMessage returned error: {data.get('error')}")
        return ActionResult(
            external_id=data.get("ts"),
            detail=f"Posted to Slack channel {channel}",
        )

    async def _post_teams(self, payload: ActionPayload) -> ActionResult:
        webhook_url = payload.target.get("webhook_url")
        if not webhook_url:
            raise ConnectorError("teams channel_recap requires 'webhook_url'")
        text = f"**{payload.title}**\n\n{payload.body}"
        resp = await self._client.post(webhook_url, json={"text": text})
        if resp.status_code >= 400:
            raise ConnectorError(f"Teams webhook post failed ({resp.status_code}): {resp.text}")
        return ActionResult(detail="Posted to Teams via incoming webhook")
