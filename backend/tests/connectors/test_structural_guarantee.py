"""The approval gate lives at the DB layer (ck_action_requires_approval) and
in this module's contract: `execute()` takes only an ActionPayload -- no
Session, no ProposedAction, no way to read or write approval status. That
is a stronger guarantee than "the code happens not to check it" -- there is
no handle to check it *with*. Verified here by signature inspection across
every connector, so a future connector can't quietly add a db param.
"""

import inspect

from app.connectors.calendar_followup import CalendarFollowupConnector
from app.connectors.channel_recap import ChannelRecapConnector
from app.connectors.email_draft import EmailDraftConnector
from app.connectors.task_create import TaskCreateConnector
from app.interfaces.actions import ActionPayload

CONNECTOR_CLASSES = [
    EmailDraftConnector,
    ChannelRecapConnector,
    TaskCreateConnector,
    CalendarFollowupConnector,
]


def test_every_connector_execute_takes_only_a_payload():
    for cls in CONNECTOR_CLASSES:
        sig = inspect.signature(cls.execute)
        params = [p for name, p in sig.parameters.items() if name != "self"]
        assert len(params) == 1, (
            f"{cls.__name__}.execute() should take exactly (payload); got {sig}"
        )
        assert params[0].annotation in (ActionPayload, "ActionPayload"), (
            f"{cls.__name__}.execute()'s only parameter must be ActionPayload; got {params[0]}"
        )


def test_every_connector_has_a_kind_matching_its_purpose():
    for cls in CONNECTOR_CLASSES:
        assert hasattr(cls, "kind"), (
            f"{cls.__name__} is missing the required `kind` class attribute"
        )
