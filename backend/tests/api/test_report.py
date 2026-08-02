"""Tests for GET /api/v1/meetings/{capture_session_id}/report."""

from datetime import UTC, datetime

from app.db.models import (
    CaptureSession,
    Confidence,
    CoverageInterval,
    CoverageStatus,
    Keyframe,
    KnowledgeEvidence,
    KnowledgeItem,
    KnowledgeType,
    LifecycleState,
    Meeting,
    Org,
    Person,
    Utterance,
)


def _seed(db):
    org = Org(name="acme")
    db.add(org)
    db.flush()

    person = Person(org_id=org.id, display_name="Nimal Perera")
    db.add(person)
    db.flush()

    meeting = Meeting(
        org_id=org.id,
        title="Infra Sync",
        platform="upload",
        scheduled_start=datetime(2026, 7, 28, 9, 0, tzinfo=UTC),
    )
    db.add(meeting)
    db.flush()

    session = CaptureSession(org_id=org.id, meeting_id=meeting.id, mode="D")
    db.add(session)
    db.flush()

    other = Person(org_id=org.id, display_name="Udula Silva")
    db.add(other)
    db.flush()

    utt = Utterance(
        org_id=org.id,
        capture_session_id=session.id,
        person_id=person.id,
        start_s=245.0,
        end_s=248.0,
        text="So we're going with Postgres and pgvector instead of a separate vector DB.",
        lang_tags=["en"],
    )
    db.add(utt)
    # Engagement fixture: Nimal talks 3s here + 27s below = 30s; Udula 10s;
    # one unattributed mixed-audio span (person_id=None) = 5s -- must appear
    # as "Unknown speaker", not silently dropped from the talk-time total.
    db.add(
        Utterance(
            org_id=org.id, capture_session_id=session.id, person_id=person.id,
            start_s=300.0, end_s=327.0, text="...", lang_tags=["si", "en"],
        )
    )
    db.add(
        Utterance(
            org_id=org.id, capture_session_id=session.id, person_id=other.id,
            start_s=330.0, end_s=340.0, text="...", lang_tags=["ta"],
        )
    )
    db.add(
        Utterance(
            org_id=org.id, capture_session_id=session.id, person_id=None,
            start_s=350.0, end_s=355.0, text="...", lang_tags=["und"],
        )
    )

    kf = Keyframe(
        org_id=org.id,
        capture_session_id=session.id,
        valid_from_s=250.0,
        valid_to_s=260.0,
        image_uri="blob://keyframes/acme/frame1.png",
        vlm_caption="Slide titled 'Datastore decision'",
    )
    db.add(kf)
    db.flush()

    item = KnowledgeItem(
        org_id=org.id,
        capture_session_id=session.id,
        type=KnowledgeType.DECISION,
        statement="Migrate the primary datastore from MongoDB to Postgres with pgvector.",
        owner_person_id=person.id,
        lifecycle_state=LifecycleState.NEW,
        confidence=Confidence.VERIFIED,
        confidence_rationale="Directly stated and corroborated by screen evidence.",
        overlaps_coverage_gap=False,
    )
    db.add(item)
    db.flush()

    db.add(KnowledgeEvidence(org_id=org.id, knowledge_item_id=item.id, utterance_id=utt.id))
    db.add(KnowledgeEvidence(org_id=org.id, knowledge_item_id=item.id, keyframe_id=kf.id))

    db.add(
        CoverageInterval(
            org_id=org.id,
            capture_session_id=session.id,
            start_s=612.0,
            end_s=701.0,
            modality="screen",
            status=CoverageStatus.MISSING,
            reason="Screen-share dropped during the cost comparison walkthrough.",
        )
    )
    # An "ok" interval must NOT show up as a gap.
    db.add(
        CoverageInterval(
            org_id=org.id,
            capture_session_id=session.id,
            start_s=0.0,
            end_s=612.0,
            modality="screen",
            status=CoverageStatus.OK,
        )
    )

    db.commit()
    return session.id, meeting.id


def test_report_groups_items_and_includes_evidence(client, db_session):
    session_id, meeting_id = _seed(db_session)

    resp = client.get(f"/api/v1/meetings/{session_id}/report")
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["meeting_id"] == meeting_id
    assert body["capture_session_id"] == session_id
    assert body["title"] == "Infra Sync"

    assert len(body["decisions"]) == 1
    assert body["commitments"] == []
    decision = body["decisions"][0]
    assert decision["statement"].startswith("Migrate the primary datastore")
    assert decision["owner"] == "Nimal Perera"
    assert decision["confidence"] == "verified"
    assert decision["lifecycle_state"] == "new"
    assert decision["coverage_gap"] is False

    assert len(decision["evidence"]) == 2
    utterance_evidence = next(e for e in decision["evidence"] if e["speaker"] == "Nimal Perera")
    assert utterance_evidence["timestamp_s"] == 245.0
    assert "Postgres" in utterance_evidence["quote"]
    assert utterance_evidence["quote_lang_tags"] == ["en"]

    keyframe_evidence = next(e for e in decision["evidence"] if e["speaker"] == "Screen capture")
    assert keyframe_evidence["keyframe_thumbnail_url"] is not None
    assert keyframe_evidence["keyframe_caption"] == "Slide titled 'Datastore decision'"

    assert len(body["coverage_gaps"]) == 1
    gap = body["coverage_gaps"][0]
    assert gap["status"] == "missing"
    assert gap["start_s"] == 612.0
    assert gap["end_s"] == 701.0


def test_report_404_for_unknown_session(client):
    resp = client.get("/api/v1/meetings/does-not-exist/report")
    assert resp.status_code == 404


def test_report_includes_participant_engagement(client, db_session):
    session_id, _ = _seed(db_session)

    resp = client.get(f"/api/v1/meetings/{session_id}/report")
    assert resp.status_code == 200, resp.text
    engagement = resp.json()["engagement"]

    # 3 + 27 (Nimal) + 10 (Udula) + 5 (unattributed) = 45s total.
    assert engagement["total_talk_time_s"] == 45.0
    assert len(engagement["participants"]) == 3

    by_name = {p["display_name"]: p for p in engagement["participants"]}
    nimal = by_name["Nimal Perera"]
    assert nimal["talk_time_s"] == 30.0
    assert nimal["utterance_count"] == 2
    assert round(nimal["talk_time_pct"], 2) == round(30.0 / 45.0 * 100, 2)

    udula = by_name["Udula Silva"]
    assert udula["talk_time_s"] == 10.0

    # Unattributed (mixed audio, no diarization yet) must surface honestly,
    # not vanish from the totals or get misattributed to someone.
    unknown = by_name["Unknown speaker"]
    assert unknown["talk_time_s"] == 5.0
    assert unknown["person_id"] is None

    # Sorted by talk time descending, most-engaged participant first.
    assert [p["display_name"] for p in engagement["participants"]] == [
        "Nimal Perera",
        "Udula Silva",
        "Unknown speaker",
    ]
