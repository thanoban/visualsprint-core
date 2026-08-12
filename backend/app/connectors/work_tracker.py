"""Jira/GitHub/Linear work-status adapters."""

import httpx

from app.capture.token_provider import TokenProvider
from app.connectors.task_create import ATLASSIAN_API_BASE, LINEAR_GRAPHQL_URL
from app.interfaces.work_tracker import WorkState, WorkStatusResult

_LINEAR_ISSUE_QUERY = """
query Issue($id: String!) {
  issue(id: $id) {
    id
    identifier
    url
    state { name type }
  }
}
"""


class JiraWorkTracker:
    def __init__(
        self,
        *,
        cloud_id: str,
        token_provider: TokenProvider,
        site_url: str | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._cloud_id = cloud_id
        self._tokens = token_provider
        self._site_url = site_url
        self._client = http_client or httpx.AsyncClient()

    async def check_status(self, external_id: str) -> WorkStatusResult:
        token = await self._tokens.get_token()
        resp = await self._client.get(
            f"{ATLASSIAN_API_BASE}/ex/jira/{self._cloud_id}/rest/api/3/issue/{external_id}",
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            params={"fields": "status"},
        )
        if resp.status_code >= 400:
            return WorkStatusResult(state=WorkState.UNKNOWN, label=f"jira {resp.status_code}")
        data = resp.json()
        status = data.get("fields", {}).get("status", {})
        category = status.get("statusCategory", {}).get("key")
        label = status.get("name") or category or ""
        state = WorkState.CLOSED if category == "done" else WorkState.OPEN
        return WorkStatusResult(
            state=state,
            label=label,
            external_url=(
                f"{self._site_url.rstrip('/')}/browse/{external_id}" if self._site_url else None
            ),
            raw={"status": status},
        )


class GitHubWorkTracker:
    def __init__(
        self,
        *,
        owner: str,
        repo: str,
        token_provider: TokenProvider,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._owner = owner
        self._repo = repo
        self._tokens = token_provider
        self._client = http_client or httpx.AsyncClient()

    async def check_status(self, external_id: str) -> WorkStatusResult:
        token = await self._tokens.get_token()
        resp = await self._client.get(
            f"https://api.github.com/repos/{self._owner}/{self._repo}/issues/{external_id}",
            headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"},
        )
        if resp.status_code >= 400:
            return WorkStatusResult(state=WorkState.UNKNOWN, label=f"github {resp.status_code}")
        data = resp.json()
        label = data.get("state") or ""
        state = WorkState.CLOSED if label == "closed" else WorkState.OPEN
        return WorkStatusResult(
            state=state,
            label=label,
            external_url=data.get("html_url"),
            raw={"state": data.get("state"), "state_reason": data.get("state_reason")},
        )


class LinearWorkTracker:
    def __init__(
        self, *, token_provider: TokenProvider, http_client: httpx.AsyncClient | None = None
    ) -> None:
        self._tokens = token_provider
        self._client = http_client or httpx.AsyncClient()

    async def check_status(self, external_id: str) -> WorkStatusResult:
        token = await self._tokens.get_token()
        resp = await self._client.post(
            LINEAR_GRAPHQL_URL,
            headers={"Authorization": f"Bearer {token}"},
            json={"query": _LINEAR_ISSUE_QUERY, "variables": {"id": external_id}},
        )
        if resp.status_code >= 400:
            return WorkStatusResult(state=WorkState.UNKNOWN, label=f"linear {resp.status_code}")
        data = resp.json()
        if data.get("errors"):
            return WorkStatusResult(state=WorkState.UNKNOWN, label="linear errors", raw=data)
        issue = data.get("data", {}).get("issue") or {}
        status = issue.get("state") or {}
        state_type = status.get("type")
        state = WorkState.CLOSED if state_type in {"completed", "canceled"} else WorkState.OPEN
        return WorkStatusResult(
            state=state,
            label=status.get("name") or state_type or "",
            external_url=issue.get("url"),
            raw={"state": status},
        )
