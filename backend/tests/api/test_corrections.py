"""Tests for the correction & glossary UI backend (app/api/corrections.py).

Covers: listing utterances for a session, submitting a correction (which must
update Utterance.text in place and preserve the original on the Correction
row), the optional glossary-term side effect, and direct glossary CRUD.
"""

from app.db.models import CaptureSession, Correction, GlossaryTerm, Meeting, Org, Person, Utterance


def _seed(db):
    org = Org(name="acme")
    db.add(org)
    db.flush()

    person = Person(org_id=org.id, display_name="Nimal Perera")
    db.add(person)
    db.flush()

    meeting = Meeting(org_id=org.id, title="Infra Sync", platform="upload")
    db.add(meeting)
    db.flush()

    session = CaptureSession(org_id=org.id, meeting_id=meeting.id, mode="D")
    db.add(session)
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
    )
    db.add(utt)
    db.commit()
    return org.id, session.id, utt.id, person.id


def test_list_utterances_returns_speaker_and_text(client, db_session):
    org_id, session_id, utt_id, _person_id = _seed(db_session)

    resp = client.get(f"/api/v1/meetings/{session_id}/utterances")
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert len(rows) == 1
    assert rows[0]["id"] == utt_id
    assert rows[0]["text"] == "deploy panna redy"
    assert rows[0]["speaker"] == "Nimal Perera"
    assert rows[0]["lang_tags"] == ["en", "si"]


def test_list_utterances_404_for_unknown_session(client, db_session):
    resp = client.get("/api/v1/meetings/does-not-exist/utterances")
    assert resp.status_code == 404


def test_submit_correction_updates_utterance_and_preserves_original(client, db_session):
    org_id, session_id, utt_id, person_id = _seed(db_session)

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
    org_id, session_id, utt_id, person_id = _seed(db_session)

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
    _org_id, _session_id, utt_id, _person_id = _seed(db_session)

    resp = client.post("/api/v1/corrections", json={"utterance_id": utt_id, "corrected_text": "   "})
    assert resp.status_code == 400


def test_submit_correction_404_for_unknown_utterance(client, db_session):
    resp = client.post(
        "/api/v1/corrections", json={"utterance_id": "nope", "corrected_text": "text"}
    )
    assert resp.status_code == 404


def test_glossary_add_list_delete_roundtrip(client, db_session):
    org_id, _session_id, _utt_id, person_id = _seed(db_session)

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
    org_id, _session_id, _utt_id, _person_id = _seed(db_session)
    resp = client.post(f"/api/v1/orgs/{org_id}/glossary", json={"term": "  "})
    assert resp.status_code == 400


def test_glossary_404_for_unknown_org(client, db_session):
    resp = client.get("/api/v1/orgs/does-not-exist/glossary")
    assert resp.status_code == 404
