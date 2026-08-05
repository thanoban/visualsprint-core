"""Tests for TaskCreateConnector (Jira/GitHub/Linear) -- flagged as untested
in the component-status audit. Each provider gets: happy path, a required-
field validation error, a not-configured error (token provider omitted),
and a surfaced (never swallowed) HTTP failure.
"""

import httpx
import pytest

from app.capture.token_provider import StaticTokenProvider
from app.connectors.errors import ConnectorError, ConnectorNotConfiguredError
from app.connectors.task_create import TaskCreateConnector
from app.interfaces.actions import ActionKind, ActionPayload


def _client_with(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


# --- Jira ---------------------------------------------------------------


async def test_jira_creates_issue_with_basic_auth():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/rest/api/3/issue"
        import base64

        auth = request.headers["authorization"]
        assert auth.startswith("Basic ")
        decoded = base64.b64decode(auth.removeprefix("Basic ")).decode()
        assert decoded == "pm@acme.test:jira-token"
        body = request.read()
        assert b'"key": "PAY"' in body or b'"key":"PAY"' in body
        return httpx.Response(201, json={"key": "PAY-501"})

    connector = TaskCreateConnector(
        jira_email="pm@acme.test",
        jira_token_provider=StaticTokenProvider("jira-token"),
        http_client=_client_with(handler),
    )
    payload = ActionPayload(
        kind=ActionKind.TASK_CREATE,
        title="Fix deploy script",
        body="The nightly deploy script fails on Sinhala filenames.",
        target={"provider": "jira", "base_url": "https://acme.atlassian.net", "project_key": "PAY"},
    )
    result = await connector.execute(payload)

    assert result.external_id == "PAY-501"
    assert result.external_url == "https://acme.atlassian.net/browse/PAY-501"


async def test_jira_requires_base_url_and_project_key():
    connector = TaskCreateConnector(
        jira_email="pm@acme.test",
        jira_token_provider=StaticTokenProvider("t"),
        http_client=_client_with(lambda r: httpx.Response(200)),
    )
    payload = ActionPayload(
        kind=ActionKind.TASK_CREATE, title="x", body="y", target={"provider": "jira"}
    )
    with pytest.raises(ConnectorError, match="requires 'base_url' and 'project_key'"):
        await connector.execute(payload)


async def test_jira_raises_not_configured_without_credentials():
    connector = TaskCreateConnector(http_client=_client_with(lambda r: httpx.Response(200)))
    payload = ActionPayload(
        kind=ActionKind.TASK_CREATE,
        title="x",
        body="y",
        target={"provider": "jira", "base_url": "https://acme.atlassian.net", "project_key": "PAY"},
    )
    with pytest.raises(ConnectorNotConfiguredError):
        await connector.execute(payload)


async def test_jira_surfaces_http_failure():
    connector = TaskCreateConnector(
        jira_email="pm@acme.test",
        jira_token_provider=StaticTokenProvider("t"),
        http_client=_client_with(lambda r: httpx.Response(403, text="forbidden")),
    )
    payload = ActionPayload(
        kind=ActionKind.TASK_CREATE,
        title="x",
        body="y",
        target={"provider": "jira", "base_url": "https://acme.atlassian.net", "project_key": "PAY"},
    )
    with pytest.raises(ConnectorError, match="403"):
        await connector.execute(payload)


# --- GitHub ---------------------------------------------------------------


async def test_github_creates_issue_with_pat():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == httpx.URL("https://api.github.com/repos/acme/visualsprint/issues")
        assert request.headers["authorization"] == "Bearer gh-token"
        return httpx.Response(
            201, json={"number": 42, "html_url": "https://github.com/acme/visualsprint/issues/42"}
        )

    connector = TaskCreateConnector(
        github_token_provider=StaticTokenProvider("gh-token"), http_client=_client_with(handler)
    )
    payload = ActionPayload(
        kind=ActionKind.TASK_CREATE,
        title="Fix deploy script",
        body="...",
        target={"provider": "github", "owner": "acme", "repo": "visualsprint"},
    )
    result = await connector.execute(payload)

    assert result.external_id == "42"
    assert result.external_url == "https://github.com/acme/visualsprint/issues/42"


async def test_github_requires_owner_and_repo():
    connector = TaskCreateConnector(
        github_token_provider=StaticTokenProvider("t"),
        http_client=_client_with(lambda r: httpx.Response(200)),
    )
    payload = ActionPayload(
        kind=ActionKind.TASK_CREATE, title="x", body="y", target={"provider": "github"}
    )
    with pytest.raises(ConnectorError, match="requires 'owner' and 'repo'"):
        await connector.execute(payload)


async def test_github_raises_not_configured_without_token():
    connector = TaskCreateConnector(http_client=_client_with(lambda r: httpx.Response(200)))
    payload = ActionPayload(
        kind=ActionKind.TASK_CREATE,
        title="x",
        body="y",
        target={"provider": "github", "owner": "acme", "repo": "visualsprint"},
    )
    with pytest.raises(ConnectorNotConfiguredError):
        await connector.execute(payload)


async def test_github_surfaces_http_failure():
    connector = TaskCreateConnector(
        github_token_provider=StaticTokenProvider("t"),
        http_client=_client_with(lambda r: httpx.Response(422, text="validation failed")),
    )
    payload = ActionPayload(
        kind=ActionKind.TASK_CREATE,
        title="x",
        body="y",
        target={"provider": "github", "owner": "acme", "repo": "visualsprint"},
    )
    with pytest.raises(ConnectorError, match="422"):
        await connector.execute(payload)


# --- Linear ---------------------------------------------------------------


async def test_linear_creates_issue_via_graphql():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == httpx.URL("https://api.linear.app/graphql")
        # OAuth access tokens are Bearer-prefixed -- distinct from Linear's
        # personal-API-key convention (sent raw), which this connector no
        # longer supports (see task_create.py's module docstring).
        assert request.headers["authorization"] == "Bearer linear-key"
        return httpx.Response(
            200,
            json={
                "data": {
                    "issueCreate": {
                        "success": True,
                        "issue": {"id": "abc", "identifier": "ENG-9", "url": "https://linear.app/acme/issue/ENG-9"},
                    }
                }
            },
        )

    connector = TaskCreateConnector(
        linear_token_provider=StaticTokenProvider("linear-key"), http_client=_client_with(handler)
    )
    payload = ActionPayload(
        kind=ActionKind.TASK_CREATE,
        title="Fix deploy script",
        body="...",
        target={"provider": "linear", "team_id": "team-1"},
    )
    result = await connector.execute(payload)

    assert result.external_id == "ENG-9"
    assert result.external_url == "https://linear.app/acme/issue/ENG-9"


async def test_linear_requires_team_id():
    connector = TaskCreateConnector(
        linear_token_provider=StaticTokenProvider("t"),
        http_client=_client_with(lambda r: httpx.Response(200)),
    )
    payload = ActionPayload(
        kind=ActionKind.TASK_CREATE, title="x", body="y", target={"provider": "linear"}
    )
    with pytest.raises(ConnectorError, match="requires 'team_id'"):
        await connector.execute(payload)


async def test_linear_raises_not_configured_without_key():
    connector = TaskCreateConnector(http_client=_client_with(lambda r: httpx.Response(200)))
    payload = ActionPayload(
        kind=ActionKind.TASK_CREATE, title="x", body="y", target={"provider": "linear", "team_id": "t1"}
    )
    with pytest.raises(ConnectorNotConfiguredError):
        await connector.execute(payload)


async def test_linear_surfaces_graphql_level_errors():
    """A 200 response can still carry a GraphQL `errors` array -- must not
    be treated as success just because the HTTP status is 200."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"errors": [{"message": "Team not found"}]})

    connector = TaskCreateConnector(
        linear_token_provider=StaticTokenProvider("t"), http_client=_client_with(handler)
    )
    payload = ActionPayload(
        kind=ActionKind.TASK_CREATE, title="x", body="y", target={"provider": "linear", "team_id": "bad"}
    )
    with pytest.raises(ConnectorError, match="Team not found"):
        await connector.execute(payload)


async def test_linear_surfaces_success_false():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": {"issueCreate": {"success": False}}})

    connector = TaskCreateConnector(
        linear_token_provider=StaticTokenProvider("t"), http_client=_client_with(handler)
    )
    payload = ActionPayload(
        kind=ActionKind.TASK_CREATE, title="x", body="y", target={"provider": "linear", "team_id": "t1"}
    )
    with pytest.raises(ConnectorError, match="success=false"):
        await connector.execute(payload)


# --- dispatch ---------------------------------------------------------------


async def test_unsupported_provider_raises():
    connector = TaskCreateConnector(http_client=_client_with(lambda r: httpx.Response(200)))
    payload = ActionPayload(
        kind=ActionKind.TASK_CREATE, title="x", body="y", target={"provider": "trello"}
    )
    with pytest.raises(ConnectorError, match="unsupported task_create provider"):
        await connector.execute(payload)
