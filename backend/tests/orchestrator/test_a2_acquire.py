import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.orchestrator.worker as worker
from app.db.base import Base
from app.db.models import (
    AudioTrack,
    CalendarConnection,
    CaptureSession,
    ConsentRecord,
    Meeting,
    Org,
    OrgConnection,
    Participant,
    Person,
    PipelineJob,
)
from app.interfaces.platform import AudioTrack as ArtifactAudioTrack
from app.interfaces.platform import CaptureArtifacts, CaptureMode, RosterEntry


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


class FakePlatformAdapter:
    mode = CaptureMode.OFFICIAL_ARTIFACTS

    def __init__(self, artifacts: CaptureArtifacts) -> None:
        self.artifacts = artifacts
        self.calls: list[str] = []

    async def acquire(self, capture_session_id: str) -> CaptureArtifacts:
        self.calls.append(capture_session_id)
        return self.artifacts


def _seed_a2_session(db, *, platform: str = "zoom", platform_meeting_id: str = "platform-123"):
    org = Org(name="Acme")
    db.add(org)
    db.flush()
    meeting = Meeting(
        org_id=org.id,
        title="A2 meeting",
        platform=platform,
        platform_meeting_id=platform_meeting_id,
    )
    db.add(meeting)
    db.flush()
    session = CaptureSession(org_id=org.id, meeting_id=meeting.id, mode="A2")
    db.add(session)
    db.flush()
    job = PipelineJob(org_id=org.id, capture_session_id=session.id, stage="acquire")
    db.add(job)
    db.commit()
    return org, meeting, session, job


async def test_a2_acquire_persists_roster_tracks_and_video_uri(db, monkeypatch):
    org, _meeting, session, job = _seed_a2_session(db)
    artifacts = CaptureArtifacts(
        mode=CaptureMode.OFFICIAL_ARTIFACTS,
        audio_tracks=[
            ArtifactAudioTrack(
                uri="blob://zoom/platform-123/alice.flac",
                participant=RosterEntry(
                    display_name="Alice",
                    email="alice@example.com",
                    platform_user_id="zoom-alice",
                ),
            ),
            ArtifactAudioTrack(
                uri="blob://zoom/platform-123/bob.flac",
                participant=RosterEntry(display_name="Bob", email="bob@example.com"),
            ),
        ],
        video_uri="blob://zoom/platform-123/video.mp4",
        roster=[
            RosterEntry(
                display_name="Alice",
                email="alice@example.com",
                platform_user_id="zoom-alice",
            ),
            RosterEntry(display_name="Bob", email="bob@example.com"),
        ],
    )
    adapter = FakePlatformAdapter(artifacts)
    monkeypatch.setattr(worker, "_platform_adapters", {"zoom": adapter})

    await worker._handle_acquire(db, job)
    db.commit()

    assert adapter.calls == ["platform-123"]
    db.refresh(session)
    assert session.video_uri == "blob://zoom/platform-123/video.mp4"

    participants = (
        db.execute(select(Participant).where(Participant.capture_session_id == session.id))
        .scalars()
        .all()
    )
    tracks = (
        db.execute(
            select(AudioTrack)
            .where(AudioTrack.capture_session_id == session.id)
            .order_by(AudioTrack.uri)
        )
        .scalars()
        .all()
    )
    people = db.execute(select(Person).where(Person.org_id == org.id)).scalars().all()

    assert {p.display_name for p in participants} == {"Alice", "Bob"}
    assert {p.email for p in people} == {"alice@example.com", "bob@example.com"}
    assert [t.participant_display_name for t in tracks] == ["Alice", "Bob"]
    assert all(t.participant_person_id for t in tracks)

    consent_records = (
        db.execute(select(ConsentRecord).where(ConsentRecord.capture_session_id == session.id))
        .scalars()
        .all()
    )
    assert len(consent_records) == 1
    assert consent_records[0].method == "host_setting"
    assert consent_records[0].subject == "all_participants"
    assert session.disclosure_log[0]["method"] == "host_setting"


async def test_a2_acquire_is_idempotent_for_retries(db, monkeypatch):
    _org, _meeting, session, job = _seed_a2_session(db, platform="meet")
    db.add(
        AudioTrack(
            org_id=session.org_id,
            capture_session_id=session.id,
            uri="blob://stale/audio.flac",
            participant_display_name="Stale",
        )
    )
    db.add(Participant(org_id=session.org_id, capture_session_id=session.id, display_name="Stale"))
    db.commit()
    artifacts = CaptureArtifacts(
        mode=CaptureMode.OFFICIAL_ARTIFACTS,
        audio_tracks=[ArtifactAudioTrack(uri="blob://meet/platform-123/mixed.flac")],
        roster=[RosterEntry(display_name="Nimal")],
        screen_share_uri="blob://meet/platform-123/share.mp4",
    )
    monkeypatch.setattr(worker, "_platform_adapters", {"meet": FakePlatformAdapter(artifacts)})

    await worker._handle_acquire(db, job)
    await worker._handle_acquire(db, job)
    db.commit()

    tracks = (
        db.execute(select(AudioTrack).where(AudioTrack.capture_session_id == session.id))
        .scalars()
        .all()
    )
    participants = (
        db.execute(select(Participant).where(Participant.capture_session_id == session.id))
        .scalars()
        .all()
    )

    assert [t.uri for t in tracks] == ["blob://meet/platform-123/mixed.flac"]
    assert tracks[0].participant_person_id is None
    assert [p.display_name for p in participants] == ["Nimal"]
    assert session.video_uri == "blob://meet/platform-123/share.mp4"

    consent_records = (
        db.execute(select(ConsentRecord).where(ConsentRecord.capture_session_id == session.id))
        .scalars()
        .all()
    )
    assert len(consent_records) == 1
    assert len(session.disclosure_log) == 1


async def test_a2_acquire_requires_platform_meeting_id(db, monkeypatch):
    _org, _meeting, _session, job = _seed_a2_session(db, platform_meeting_id="")
    monkeypatch.setattr(
        worker,
        "_platform_adapters",
        {
            "zoom": FakePlatformAdapter(
                CaptureArtifacts(mode=CaptureMode.OFFICIAL_ARTIFACTS, audio_tracks=[])
            )
        },
    )

    with pytest.raises(RuntimeError, match="platform_meeting_id"):
        await worker._handle_acquire(db, job)


async def test_platform_adapter_unknown_platform_returns_none(db):
    assert worker._get_platform_adapter_for_session(db, "org-1", "not-a-real-platform") is None


async def test_platform_adapter_falls_back_to_unconfigured_when_org_never_connected(db, monkeypatch):
    """No OrgConnection/CalendarConnection row for this org+platform --
    still returns a real adapter (not None), just one whose token
    provider fails loudly and specifically when actually used, matching
    every other connector in this codebase rather than a generic
    "no adapter" error."""
    org = Org(name="Acme")
    db.add(org)
    db.commit()
    monkeypatch.delenv("VS_ZOOM_OAUTH_CLIENT_ID", raising=False)
    from app.config import get_settings

    get_settings.cache_clear()
    try:
        adapter = worker._get_platform_adapter_for_session(db, org.id, "zoom")
    finally:
        get_settings.cache_clear()

    from app.capture.token_provider import UnconfiguredTokenProvider
    from app.capture.zoom_adapter import ZoomAdapter

    assert isinstance(adapter, ZoomAdapter)
    assert isinstance(adapter._tokens, UnconfiguredTokenProvider)


async def test_platform_adapter_uses_a_real_per_org_token_provider_when_connected(db, monkeypatch):
    org = Org(name="Acme")
    db.add(org)
    db.flush()
    db.add(
        OrgConnection(
            org_id=org.id, provider="zoom", account_label="ops@acme.test", external_id="zoom-acc",
            secret_ref="oauth/zoom/x",
        )
    )
    db.commit()
    monkeypatch.setenv("VS_ZOOM_OAUTH_CLIENT_ID", "cid")
    monkeypatch.setenv("VS_ZOOM_OAUTH_CLIENT_SECRET", "csecret")
    from app.config import get_settings

    get_settings.cache_clear()
    try:
        adapter = worker._get_platform_adapter_for_session(db, org.id, "zoom")
    finally:
        get_settings.cache_clear()

    from app.capture.oauth_token_provider import OAuthTokenProvider

    assert isinstance(adapter._tokens, OAuthTokenProvider)
    assert adapter._tokens._secret_ref == "oauth/zoom/x"


async def test_two_orgs_capturing_on_meet_get_their_own_google_connections(db, monkeypatch):
    """The regression this fix closes: a single shared MeetAdapter across
    every org would mean org B's Mode A2 acquire could silently use org
    A's Google Meet token."""
    org_a = Org(name="org-a")
    org_b = Org(name="org-b")
    db.add_all([org_a, org_b])
    db.flush()
    db.add(
        CalendarConnection(
            org_id=org_a.id, provider="google", account_email="a@acme.test", secret_ref="oauth/google/a"
        )
    )
    db.add(
        CalendarConnection(
            org_id=org_b.id, provider="google", account_email="b@acme.test", secret_ref="oauth/google/b"
        )
    )
    db.commit()
    monkeypatch.setenv("VS_GOOGLE_OAUTH_CLIENT_ID", "cid")
    monkeypatch.setenv("VS_GOOGLE_OAUTH_CLIENT_SECRET", "csecret")
    from app.config import get_settings

    get_settings.cache_clear()
    try:
        adapter_a = worker._get_platform_adapter_for_session(db, org_a.id, "meet")
        adapter_b = worker._get_platform_adapter_for_session(db, org_b.id, "meet")
    finally:
        get_settings.cache_clear()

    assert adapter_a._tokens._secret_ref == "oauth/google/a"
    assert adapter_b._tokens._secret_ref == "oauth/google/b"


async def test_teams_platform_adapter_uses_microsoft_oauth(db, monkeypatch):
    org = Org(name="Acme")
    db.add(org)
    db.flush()
    db.add(
        CalendarConnection(
            org_id=org.id, provider="microsoft", account_email="ops@acme.test", secret_ref="oauth/microsoft/x"
        )
    )
    db.commit()
    monkeypatch.setenv("VS_MICROSOFT_OAUTH_CLIENT_ID", "cid")
    monkeypatch.setenv("VS_MICROSOFT_OAUTH_CLIENT_SECRET", "csecret")
    from app.config import get_settings

    get_settings.cache_clear()
    try:
        adapter = worker._get_platform_adapter_for_session(db, org.id, "teams")
    finally:
        get_settings.cache_clear()

    from app.capture.teams_adapter import TeamsAdapter

    assert isinstance(adapter, TeamsAdapter)
    assert adapter._tokens._secret_ref == "oauth/microsoft/x"
