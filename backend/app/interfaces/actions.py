"""ActionConnector swap point — human-gated external actions.

Connectors EXECUTE only; they never decide. Execution requires an approved
proposed_action row (DB-enforced). Implementations: email draft, Slack/Teams
recap, Jira/GitHub/Linear task, calendar invite.
"""

from enum import StrEnum
from typing import Protocol

from pydantic import BaseModel


class ActionKind(StrEnum):
    EMAIL_DRAFT = "email_draft"
    CHANNEL_RECAP = "channel_recap"
    TASK_CREATE = "task_create"
    CALENDAR_FOLLOWUP = "calendar_followup"
    ESCALATION = "escalation"
    REMINDER = "reminder"


class ActionPayload(BaseModel):
    kind: ActionKind
    title: str
    body: str
    target: dict[str, str] = {}  # connector-specific (channel id, project key, recipient…)
    evidence_item_ids: list[str] = []  # knowledge items justifying this action


class ActionResult(BaseModel):
    external_id: str | None = None  # e.g. Jira issue key
    external_url: str | None = None
    detail: str = ""


class ActionConnector(Protocol):
    kind: ActionKind

    async def execute(self, payload: ActionPayload) -> ActionResult:
        """Execute an APPROVED action. Caller guarantees the approval record exists."""
        ...
