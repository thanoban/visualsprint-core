"""Raw-evidence retention sweep. The one guarantee that matters most here:
KnowledgeItem/KnowledgeEvidence (verified organizational memory) must
survive a purge completely untouched -- only the raw recording content
(audio blobs, utterance text, keyframe images/OCR) is ever deleted."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.models import (
    AudioTrack,
    CaptureSession,
    Confidence,
    Keyframe,
    KnowledgeEvidence,
    KnowledgeItem,
    KnowledgeType,
    Meeting,
    Org,
    Utterance,
)
from app.orchestrator.retention import purge_expired_raw_evidence


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


class FakeBlobStore:
    def __init__(self) -> None:
        self.deleted: list[str] = []

    async def delete(self, uri: str) -> None:
        self.deleted.append(uri)


def _seed(
    db,
    *,
    retention_days: int | None,
    meeting_age_days: int,
    mode_d_no_scheduled_start: bool = False,
) -> tuple[Org, CaptureSession, Utterance, Keyframe, AudioTrack, KnowledgeItem]:
    org = Org(name="Acme", retention_days=retention_days)
    db.add(org)
    db.flush()

    scheduled_start = None
    if not mode_d_no_scheduled_start:
        scheduled_start = datetime.now(UTC) - timedelta(days=meeting_age_days)
    meeting = Meeting(org_id=org.id, title="Standup", platform="upload", scheduled_start=scheduled_start)
    db.add(meeting)
    db.flush()

    session = CaptureSession(org_id=org.id, meeting_id=meeting.id, mode="D")
    db.add(session)
    db.flush()
    if mode_d_no_scheduled_start:
        # created_at is the fallback anchor when Meeting has no scheduled_start.
        session.created_at = datetime.now(UTC) - timedelta(days=meeting_age_days)

    track = AudioTrack(org_id=org.id, capture_session_id=session.id, uri="blob://audio/acme/x.flac")
    db.add(track)

    utt = Utterance(
        org_id=org.id, capture_session_id=session.id, start_s=0.0, end_s=2.0,
        text="we decided to use Postgres", asr_confidence=0.9,
    )
    db.add(utt)
    db.flush()

    kf = Keyframe(
        org_id=org.id, capture_session_id=session.id, valid_from_s=0.0, valid_to_s=5.0,
        image_uri="blob://keyframes/acme/frame1.jpg", ocr_text="PAY-442", vlm_caption="a slide",
        detected_entities=[{"text": "PAY-442"}],
    )
    db.add(kf)
    db.flush()

    item = KnowledgeItem(
        org_id=org.id, capture_session_id=session.id, type=KnowledgeType.DECISION,
        statement="Use Postgres for the database", confidence=Confidence.VERIFIED,
        confidence_rationale="clear statement",
    )
    db.add(item)
    db.flush()
    db.add(KnowledgeEvidence(org_id=org.id, knowledge_item_id=item.id, utterance_id=utt.id))
    db.add(KnowledgeEvidence(org_id=org.id, knowledge_item_id=item.id, keyframe_id=kf.id))
    db.commit()

    return org, session, utt, kf, track, item


async def test_no_retention_policy_is_a_complete_noop(db):
    org, session, utt, kf, track, item = _seed(db, retention_days=None, meeting_age_days=9999)
    blob_store = FakeBlobStore()

    purged = await purge_expired_raw_evidence(db, org, blob_store)

    assert purged == []
    assert utt.text == "we decided to use Postgres"
    assert kf.image_uri == "blob://keyframes/acme/frame1.jpg"
    assert track.uri == "blob://audio/acme/x.flac"
    assert blob_store.deleted == []


async def test_session_within_retention_window_is_untouched(db):
    org, session, utt, kf, track, item = _seed(db, retention_days=90, meeting_age_days=10)
    blob_store = FakeBlobStore()

    purged = await purge_expired_raw_evidence(db, org, blob_store)

    assert purged == []
    assert utt.text != ""
    assert kf.image_uri != ""
    assert track.uri != ""


async def test_session_past_retention_window_has_raw_evidence_purged(db):
    org, session, utt, kf, track, item = _seed(db, retention_days=90, meeting_age_days=120)
    blob_store = FakeBlobStore()

    purged = await purge_expired_raw_evidence(db, org, blob_store)

    assert purged == [session.id]
    assert utt.text == ""
    assert kf.image_uri == ""
    assert kf.ocr_text == ""
    assert kf.vlm_caption == ""
    assert kf.detected_entities == []
    assert track.uri == ""
    assert set(blob_store.deleted) == {"blob://audio/acme/x.flac", "blob://keyframes/acme/frame1.jpg"}


async def test_knowledge_item_and_evidence_survive_completely_untouched(db):
    """The core guarantee: verified organizational memory is never purged,
    only the raw recording it was derived from."""
    org, session, utt, kf, track, item = _seed(db, retention_days=90, meeting_age_days=120)
    blob_store = FakeBlobStore()

    await purge_expired_raw_evidence(db, org, blob_store)

    assert item.statement == "Use Postgres for the database"
    assert item.confidence == Confidence.VERIFIED
    evidence_rows = (
        db.query(KnowledgeEvidence).filter(KnowledgeEvidence.knowledge_item_id == item.id).all()
    )
    assert len(evidence_rows) == 2  # both evidence links still point at the (now-blank) rows


async def test_mode_d_upload_falls_back_to_capture_session_created_at(db):
    """Mode D uploads have no calendar event -- Meeting.scheduled_start is
    None, so the sweep must anchor on when the session was created instead."""
    org, session, utt, kf, track, item = _seed(
        db, retention_days=90, meeting_age_days=120, mode_d_no_scheduled_start=True
    )
    blob_store = FakeBlobStore()

    purged = await purge_expired_raw_evidence(db, org, blob_store)

    assert purged == [session.id]
    assert utt.text == ""


async def test_purge_is_idempotent_on_a_second_run(db):
    org, session, utt, kf, track, item = _seed(db, retention_days=90, meeting_age_days=120)
    blob_store = FakeBlobStore()

    first = await purge_expired_raw_evidence(db, org, blob_store)
    second = await purge_expired_raw_evidence(db, org, blob_store)

    assert first == [session.id]
    assert second == []  # nothing left to purge -- already blank
    assert len(blob_store.deleted) == 2  # not deleted twice
