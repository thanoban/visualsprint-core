"""External work status swap point.

Create-side task connectors turn commitments into Jira/GitHub/Linear work.
This read-side interface checks whether that work is still open or closed.
"""

from enum import StrEnum
from typing import Protocol

from pydantic import BaseModel


class WorkState(StrEnum):
    OPEN = "open"
    CLOSED = "closed"
    UNKNOWN = "unknown"


class WorkStatusResult(BaseModel):
    state: WorkState
    label: str = ""
    external_url: str | None = None
    raw: dict[str, object] = {}


class WorkTracker(Protocol):
    async def check_status(self, external_id: str) -> WorkStatusResult: ...
