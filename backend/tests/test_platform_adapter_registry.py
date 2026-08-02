"""worker._get_platform_adapters() is the acquire stage's only route to a
real PlatformAdapter for Mode A2 -- a silently-missing entry here means a
platform that looks wired everywhere else (docs, tests, the adapter class
itself) actually can't ever be reached in production. Cheap regression
guard against that class of gap.
"""

import app.orchestrator.worker as worker
from app.capture.meet_adapter import MeetAdapter
from app.capture.teams_adapter import TeamsAdapter
from app.capture.zoom_adapter import ZoomAdapter
from app.interfaces.platform import CaptureMode


def test_registry_has_an_adapter_for_every_a2_platform():
    worker._platform_adapters = None  # force a fresh build regardless of test order
    adapters = worker._get_platform_adapters()

    assert isinstance(adapters["meet"], MeetAdapter)
    assert isinstance(adapters["zoom"], ZoomAdapter)
    assert isinstance(adapters["teams"], TeamsAdapter)
    for adapter in adapters.values():
        assert adapter.mode == CaptureMode.OFFICIAL_ARTIFACTS


def test_registry_is_memoized_not_rebuilt_per_call():
    worker._platform_adapters = None
    first = worker._get_platform_adapters()
    second = worker._get_platform_adapters()
    assert first is second
