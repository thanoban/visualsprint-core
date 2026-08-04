"""On-demand right-to-erasure: unlike retention.py's automatic sweep, this
deletes everything derived from a meeting -- including knowledge -- and
every blob it referenced."""

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.models import (
    AudioTrack,
    CaptureSession,
    Confidence,
    ConsentRecord,
    Correction,
    CoverageInterval,
    CoverageStatus,
    GlossaryTerm,
    Keyframe,
    KnowledgeEdge,
    KnowledgeEvidence,
    KnowledgeItem,
    KnowledgeType,
    Meeting,
    Org,
    Participant,
    ProposedAction,
    Utterance,
    UtteranceKeyframe,
)
from app.orchestrator.erasure import erase_meeting


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


async def test_erase_meeting_removes_everything_and_deletes_blobs(db):
    org = Org(name="Acme")
    db.add(org)
    db.flush()
    meeting = Meeting(org_id=org.id, title="Standup", platform="upload")
    db.add(meeting)
    db.flush()
    session = CaptureSession(
        org_id=org.id, meeting_id=meeting.id, mode="D", video_uri="blob://vid.mp4"
    )
    db.add(session)
    db.flush()

    audio = AudioTrack(org_id=org.id, capture_session_id=session.id, uri="blob://audio.flac")
    db.add(audio)
    utt = Utterance(
        org_id=org.id, capture_session_id=session.id, start_s=0, end_s=1, text="hello"
    )
    db.add(utt)
    db.flush()
    kf = Keyframe(
        org_id=org.id,
        capture_session_id=session.id,
        valid_from_s=0,
        valid_to_s=1,
        image_uri="blob://kf.png",
    )
    db.add(kf)
    db.flush()
    db.add(UtteranceKeyframe(org_id=org.id, utterance_id=utt.id, keyframe_id=kf.id, score=1.0, method="both"))

    ki = KnowledgeItem(
        org_id=org.id,
        capture_session_id=session.id,
        type=KnowledgeType.DECISION,
        statement="Use Postgres",
        confidence=Confidence.VERIFIED,
    )
    db.add(ki)
    db.flush()
    db.add(KnowledgeEvidence(org_id=org.id, knowledge_item_id=ki.id, utterance_id=utt.id))

    ki2 = KnowledgeItem(
        org_id=org.id,
        capture_session_id=session.id,
        type=KnowledgeType.FACT,
        statement="related",
    )
    db.add(ki2)
    db.flush()
    db.add(KnowledgeEdge(org_id=org.id, from_item_id=ki.id, to_item_id=ki2.id, kind="continues"))

    correction = Correction(
        org_id=org.id, utterance_id=utt.id, original_text="helo", corrected_text="hello"
    )
    db.add(correction)
    db.flush()
    glossary = GlossaryTerm(org_id=org.id, term="Postgres", source_correction_id=correction.id)
    db.add(glossary)

    db.add(ConsentRecord(org_id=org.id, capture_session_id=session.id, subject="uploader", method="upload_attestation"))
    db.add(
        CoverageInterval(
            org_id=org.id,
            capture_session_id=session.id,
            start_s=0,
            end_s=1,
            modality="audio",
            status=CoverageStatus.OK,
        )
    )
    db.add(Participant(org_id=org.id, capture_session_id=session.id, display_name="Nimal"))
    db.add(
        ProposedAction(
            org_id=org.id,
            capture_session_id=session.id,
            kind="email_draft",
            payload={"title": "t", "body": "b", "target": {}},
        )
    )
    db.commit()

    blob_store = FakeBlobStore()
    await erase_meeting(db, meeting, blob_store)
    db.commit()

    assert db.get(Meeting, meeting.id) is None
    assert db.get(CaptureSession, session.id) is None
    assert db.execute(select(Utterance)).scalars().all() == []
    assert db.execute(select(Keyframe)).scalars().all() == []
    assert db.execute(select(AudioTrack)).scalars().all() == []
    assert db.execute(select(KnowledgeItem)).scalars().all() == []
    assert db.execute(select(KnowledgeEvidence)).scalars().all() == []
    assert db.execute(select(KnowledgeEdge)).scalars().all() == []
    assert db.execute(select(UtteranceKeyframe)).scalars().all() == []
    assert db.execute(select(Correction)).scalars().all() == []
    assert db.execute(select(ConsentRecord)).scalars().all() == []
    assert db.execute(select(CoverageInterval)).scalars().all() == []
    assert db.execute(select(Participant)).scalars().all() == []
    assert db.execute(select(ProposedAction)).scalars().all() == []

    assert set(blob_store.deleted) == {"blob://audio.flac", "blob://kf.png", "blob://vid.mp4"}

    # GlossaryTerm outlives the meeting -- only the dangling reference is cleared.
    remaining_glossary = db.get(GlossaryTerm, glossary.id)
    assert remaining_glossary is not None
    assert remaining_glossary.source_correction_id is None
