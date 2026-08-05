"""Jira/GitHub/Linear task connector — ActionKind.TASK_CREATE.

Dispatches on `ActionPayload.target["provider"]` (`"jira"`, `"github"`,
`"linear"`). Each provider has its own auth shape, all injected — never
hardcoded:

- Jira Cloud: Basic auth (`email:api_token`), via `jira_email` +
  `jira_token_provider`. `target`: base_url, project_key, issue_type (optional).
- GitHub: OAuth access token via `github_token_provider`, sent as
  `Authorization: Bearer`. `target`: owner, repo.
- Linear: OAuth access token via `linear_token_provider`, sent as
  `Authorization: Bearer` -- Linear's GraphQL API distinguishes OAuth
  tokens (Bearer-prefixed) from personal API keys (sent raw); this
  connector only ever receives real OAuth grants (app/oauth/), never a
  manually-pasted personal key. `target`: team_id.
"""

import base64

import httpx

from app.capture.token_provider import TokenProvider
from app.connectors.errors import ConnectorError, ConnectorNotConfiguredError
from app.interfaces.actions import ActionKind, ActionPayload, ActionResult

LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql"

_ISSUE_CREATE_MUTATION = """
mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { id identifier url }
  }
}
"""


class TaskCreateConnector:
    kind = ActionKind.TASK_CREATE

    def __init__(
        self,
        *,
        jira_email: str | None = None,
        jira_token_provider: TokenProvider | None = None,
        github_token_provider: TokenProvider | None = None,
        linear_token_provider: TokenProvider | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._jira_email = jira_email
        self._jira_tokens = jira_token_provider
        self._github_tokens = github_token_provider
        self._linear_tokens = linear_token_provider
        self._client = http_client or httpx.AsyncClient()

    async def execute(self, payload: ActionPayload) -> ActionResult:
        provider = payload.target.get("provider")
        if provider == "jira":
            return await self._create_jira(payload)
        if provider == "github":
            return await self._create_github(payload)
        if provider == "linear":
            return await self._create_linear(payload)
        raise ConnectorError(f"unsupported task_create provider: {provider!r}")

    async def _create_jira(self, payload: ActionPayload) -> ActionResult:
        base_url = payload.target.get("base_url")
        project_key = payload.target.get("project_key")
        if not base_url or not project_key:
            raise ConnectorError("jira task_create requires 'base_url' and 'project_key'")
        if self._jira_email is None or self._jira_tokens is None:
            raise ConnectorNotConfiguredError("jira_email/jira_token_provider not configured")

        api_token = await self._jira_tokens.get_token()
        basic = base64.b64encode(f"{self._jira_email}:{api_token}".encode()).decode("ascii")
        issue_type = payload.target.get("issue_type", "Task")

        resp = await self._client.post(
            f"{base_url.rstrip('/')}/rest/api/3/issue",
            headers={"Authorization": f"Basic {basic}"},
            json={
                "fields": {
                    "project": {"key": project_key},
                    "summary": payload.title,
                    "description": {
                        "type": "doc",
                        "version": 1,
                        "content": [
                            {
                                "type": "paragraph",
                                "content": [{"type": "text", "text": payload.body}],
                            }
                        ],
                    },
                    "issuetype": {"name": issue_type},
                }
            },
        )
        if resp.status_code >= 400:
            raise ConnectorError(f"Jira issue creation failed ({resp.status_code}): {resp.text}")
        data = resp.json()
        key = data.get("key")
        return ActionResult(
            external_id=key,
            external_url=f"{base_url.rstrip('/')}/browse/{key}" if key else None,
            detail="Jira issue created",
        )

    async def _create_github(self, payload: ActionPayload) -> ActionResult:
        owner = payload.target.get("owner")
        repo = payload.target.get("repo")
        if not owner or not repo:
            raise ConnectorError("github task_create requires 'owner' and 'repo'")
        if self._github_tokens is None:
            raise ConnectorNotConfiguredError("github_token_provider not configured")

        token = await self._github_tokens.get_token()
        resp = await self._client.post(
            f"https://api.github.com/repos/{owner}/{repo}/issues",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
            },
            json={"title": payload.title, "body": payload.body},
        )
        if resp.status_code >= 400:
            raise ConnectorError(f"GitHub issue creation failed ({resp.status_code}): {resp.text}")
        data = resp.json()
        return ActionResult(
            external_id=str(data.get("number")) if data.get("number") is not None else None,
            external_url=data.get("html_url"),
            detail="GitHub issue created",
        )

    async def _create_linear(self, payload: ActionPayload) -> ActionResult:
        team_id = payload.target.get("team_id")
        if not team_id:
            raise ConnectorError("linear task_create requires 'team_id'")
        if self._linear_tokens is None:
            raise ConnectorNotConfiguredError("linear_token_provider not configured")

        access_token = await self._linear_tokens.get_token()
        resp = await self._client.post(
            LINEAR_GRAPHQL_URL,
            headers={"Authorization": f"Bearer {access_token}"},
            json={
                "query": _ISSUE_CREATE_MUTATION,
                "variables": {
                    "input": {
                        "teamId": team_id,
                        "title": payload.title,
                        "description": payload.body,
                    }
                },
            },
        )
        if resp.status_code >= 400:
            raise ConnectorError(
                f"Linear issueCreate request failed ({resp.status_code}): {resp.text}"
            )
        data = resp.json()
        if data.get("errors"):
            raise ConnectorError(f"Linear issueCreate returned errors: {data['errors']}")
        result = data.get("data", {}).get("issueCreate", {})
        if not result.get("success"):
            raise ConnectorError("Linear issueCreate reported success=false")
        issue = result.get("issue", {})
        return ActionResult(
            external_id=issue.get("identifier"),
            external_url=issue.get("url"),
            detail="Linear issue created",
        )
