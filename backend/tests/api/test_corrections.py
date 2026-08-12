"""Tests for the correction & glossary UI backend (app/api/corrections.py).

Covers: listing utterances for a session, submitting a correction (which must
update Utterance.text in place and preserve the original on the Correction
row), the optional glossary-term side effect, and direct glossary CRUD.
"""

import app.auth.dependency as auth_dep
from app.auth.dependency import is_org_member as _real_is_org_member
from app.db.models import (
    CaptureSession,
    Confidence,
    Correction,
    GlossaryTerm,
    KnowledgeItem,
    KnowledgeType,
    Meeting,
    Org,
    Person,
    SessionSpeaker,
    SpeakerResolution,
    Utterance,
)


def _seed(db):
    org = Org(name="acme")
    db.add(org)
    db.flush()

    person = Person(org_id=org.id, display_name="Nimal Perera")
    db.add(person)
    db.flush()

    other_person = Person(org_id=org.id, display_name="Kasun Silva")
    db.add(other_person)
    db.flush()

    meeting = Meeting(org_id=org.id, title="Infra Sync", platform="upload")
    db.add(meeting)
    db.flush()

    session = CaptureSession(org_id=org.id, meeting_id=meeting.id, mode="D")
    db.add(session)
    db.flush()

    speaker = SessionSpeaker(
        org_id=org.id,
        capture_session_id=session.id,
        cluster_id="SPEAKER_00",
        person_id=person.id,
        resolution_method=SpeakerResolution.ROSTER,
        confidence=0.82,
    )
    db.add(speaker)
    db.flush()

    utt = Utterance(
        org_id=org.id,
        capture_session_id=session.id,
        person_id=person.id,
        start_s=10.0,
        end_s=12.0,
        text="deploy panna redy",  # ASR mis-hearing "ready"
        lang_tags=["en", "si"],
        asr_confidence=0.7,
        speaker_cluster_id="SPEAKER_00",
        attribution_confidence=0.82,
    )
    db.add(utt)
    db.flush()

    item = KnowledgeItem(
        org_id=org.id,
        capture_session_id=session.id,
        type=KnowledgeType.COMMITMENT,
        statement="Nimal will deploy the API.",
        owner_person_id=person.id,
        owner_utterance_id=utt.id,
        owner_source="speaker",
        owner_attribution_confidence=0.82,
        confidence=Confidence.VERIFIED,
    )
    db.add(item)
    db.commit()
    return org.id, session.id, utt.id, person.id, other_person.id, speaker.id, item.id


def test_list_utterances_returns_speaker_and_text(client, db_session):
    org_id, session_id, utt_id, _person_id, _other_person_id, _speaker_id, _item_id = _seed(
        db_session
    )

    resp = client.get(f"/api/v1/meetings/{session_id}/utterances")
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert len(rows) == 1
    assert rows[0]["id"] == utt_id
    assert rows[0]["text"] == "deploy panna redy"
    assert rows[0]["speaker"] == "Nimal Perera"
    assert rows[0]["speaker_cluster_id"] == "SPEAKER_00"
    assert rows[0]["person_id"] == _person_id
    assert rows[0]["lang_tags"] == ["en", "si"]


def test_list_utterances_404_for_unknown_session(client, db_session):
    resp = client.get("/api/v1/meetings/does-not-exist/utterances")
    assert resp.status_code == 404


def test_submit_correction_updates_utterance_and_preserves_original(client, db_session):
    org_id, session_id, utt_id, person_id, _other_person_id, _speaker_id, _item_id = _seed(
        db_session
    )

    resp = client.post(
        "/api/v1/corrections",
        json={
            "utterance_id": utt_id,
            "corrected_text": "deploy panna ready",
            "training_consent": True,
            "corrected_by_person_id": person_id,
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["original_text"] == "deploy panna redy"
    assert body["corrected_text"] == "deploy panna ready"
    assert body["glossary_term_id"] is None

    updated = db_session.get(Utterance, utt_id)
    assert updated.text == "deploy panna ready"

    correction = db_session.query(Correction).filter(Correction.utterance_id == utt_id).one()
    assert correction.original_text == "deploy panna redy"
    assert correction.corrected_text == "deploy panna ready"
    assert correction.training_consent is True


def test_submit_correction_with_glossary_term_creates_both_rows(client, db_session):
    org_id, session_id, utt_id, person_id, _other_person_id, _speaker_id, _item_id = _seed(
        db_session
    )

    resp = client.post(
        "/api/v1/corrections",
        json={
            "utterance_id": utt_id,
            "corrected_text": "PAY-442 eka blocked venawa",
            "glossary_term": "PAY-442",
            "corrected_by_person_id": person_id,
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["glossary_term_id"] is not None

    term = db_session.get(GlossaryTerm, body["glossary_term_id"])
    assert term.term == "PAY-442"
    assert term.org_id == org_id
    assert term.source_correction_id == body["id"]


def test_submit_correction_rejects_empty_text(client, db_session):
    _org_id, _session_id, utt_id, _person_id, _other_person_id, _speaker_id, _item_id = _seed(
        db_session
    )

    resp = client.post(
        "/api/v1/corrections", json={"utterance_id": utt_id, "corrected_text": "   "}
    )
    assert resp.status_code == 400


def test_submit_correction_404_for_unknown_utterance(client, db_session):
    resp = client.post(
        "/api/v1/corrections", json={"utterance_id": "nope", "corrected_text": "text"}
    )
    assert resp.status_code == 404


def test_glossary_add_list_delete_roundtrip(client, db_session):
    org_id, _session_id, _utt_id, person_id, _other_person_id, _speaker_id, _item_id = _seed(
        db_session
    )

    add_resp = client.post(
        f"/api/v1/orgs/{org_id}/glossary",
        json={"term": "JWT", "added_by_person_id": person_id},
    )
    assert add_resp.status_code == 200, add_resp.text
    term_id = add_resp.json()["id"]
    assert add_resp.json()["added_by"] == "Nimal Perera"

    list_resp = client.get(f"/api/v1/orgs/{org_id}/glossary")
    assert list_resp.status_code == 200
    terms = list_resp.json()
    assert len(terms) == 1
    assert terms[0]["term"] == "JWT"

    del_resp = client.delete(f"/api/v1/orgs/{org_id}/glossary/{term_id}")
    assert del_resp.status_code == 204

    list_resp2 = client.get(f"/api/v1/orgs/{org_id}/glossary")
    assert list_resp2.json() == []


def test_glossary_add_rejects_empty_term(client, db_session):
    org_id, _session_id, _utt_id, _person_id, _other_person_id, _speaker_id, _item_id = _seed(
        db_session
    )
    resp = client.post(f"/api/v1/orgs/{org_id}/glossary", json={"term": "  "})
    assert resp.status_code == 400


def test_glossary_403_for_a_non_member_org(client, db_session, monkeypatch):
    # See test_actions.py's equivalent test for why the real is_org_member
    # is restored here instead of relying on conftest.py's default bypass.
    monkeypatch.setattr(auth_dep, "is_org_member", _real_is_org_member)
    resp = client.get("/api/v1/orgs/does-not-exist/glossary")
    assert resp.status_code == 403


def test_speaker_picker_lists_clusters_and_people(client, db_session):
    _org_id, session_id, _utt_id, person_id, other_person_id, speaker_id, _item_id = _seed(
        db_session
    )

    resp = client.get(f"/api/v1/meetings/{session_id}/speakers")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert {person["id"] for person in body["people"]} == {person_id, other_person_id}
    assert body["speakers"] == [
        {
            "id": speaker_id,
            "cluster_id": "SPEAKER_00",
            "person_id": person_id,
            "display_name": "Nimal Perera",
            "resolution_method": "roster",
            "confidence": 0.82,
            "utterance_count": 1,
        }
    ]


def test_speaker_correction_reattributes_utterances_and_speaker_owned_items(client, db_session):
    (
        _org_id,
        session_id,
        utt_id,
        old_person_id,
        new_person_id,
        speaker_id,
        item_id,
    ) = _seed(db_session)

    resp = client.post(
        f"/api/v1/meetings/{session_id}/speakers/{speaker_id}",
        json={"person_id": new_person_id},
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["person_id"] == new_person_id
    assert body["utterance_ids"] == [utt_id]
    assert body["updated_owner_item_ids"] == [item_id]

    speaker = db_session.get(SessionSpeaker, speaker_id)
    assert speaker.person_id == new_person_id
    assert speaker.resolution_method == SpeakerResolution.MANUAL
    assert speaker.confidence == 1.0

    utt = db_session.get(Utterance, utt_id)
    assert utt.person_id == new_person_id
    assert utt.attribution_confidence == 1.0

    item = db_session.get(KnowledgeItem, item_id)
    assert item.owner_person_id == new_person_id
    assert item.owner_candidate_person_id is None
    assert item.owner_attribution_confidence == 1.0
    assert item.owner_source == "speaker"
    assert old_person_id != new_person_id
