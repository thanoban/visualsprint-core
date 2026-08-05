"""Export + on-demand erasure endpoints (app/api/data_rights.py)."""

from app.db.models import AudioTrack, CaptureSession, Meeting, Org, Utterance


def _seed_meeting(db_session):
    org = Org(name="Acme")
    db_session.add(org)
    db_session.flush()
    meeting = Meeting(org_id=org.id, title="Standup", platform="upload")
    db_session.add(meeting)
    db_session.flush()
    session = CaptureSession(org_id=org.id, meeting_id=meeting.id, mode="D")
    db_session.add(session)
    db_session.flush()
    db_session.add(AudioTrack(org_id=org.id, capture_session_id=session.id, uri="blob://audio.flac"))
    db_session.add(
        Utterance(org_id=org.id, capture_session_id=session.id, start_s=0, end_s=1, text="hello")
    )
    db_session.commit()
    return org, meeting, session


def test_export_meeting_returns_full_dump(client, db_session):
    org, meeting, session = _seed_meeting(db_session)

    resp = client.get(f"/api/v1/orgs/{org.id}/meetings/{meeting.id}/export")

    assert resp.status_code == 200
    body = resp.json()
    assert body["meeting_id"] == meeting.id
    assert body["title"] == "Standup"
    assert len(body["capture_sessions"]) == 1
    dump = body["capture_sessions"][0]
    assert dump["capture_session_id"] == session.id
    assert dump["utterances"] == [
        {"start_s": 0.0, "end_s": 1.0, "text": "hello", "lang_tags": [], "provider": ""}
    ]
    assert dump["audio_tracks"] == [{"uri": "blob://audio.flac", "participant_display_name": None}]


def test_export_meeting_404_for_wrong_org(client, db_session):
    org, meeting, _session = _seed_meeting(db_session)
    other_org = Org(name="Other")
    db_session.add(other_org)
    db_session.commit()

    resp = client.get(f"/api/v1/orgs/{other_org.id}/meetings/{meeting.id}/export")

    assert resp.status_code == 404


def test_delete_meeting_erases_everything(client, db_session):
    org, meeting, session = _seed_meeting(db_session)

    resp = client.delete(f"/api/v1/orgs/{org.id}/meetings/{meeting.id}", params={"requested_by": "nimal"})

    assert resp.status_code == 200
    assert resp.json() == {"meeting_id": meeting.id, "erased": True}
    assert db_session.get(Meeting, meeting.id) is None
    assert db_session.get(CaptureSession, session.id) is None

    from sqlalchemy import select

    from app.db.models import AuditLog

    audit = db_session.execute(select(AuditLog).where(AuditLog.org_id == org.id)).scalars().all()
    erasure_entries = [a for a in audit if a.event == "meeting_erasure_requested"]
    assert len(erasure_entries) == 1
    assert erasure_entries[0].detail == {"meeting_id": meeting.id}


def test_delete_meeting_does_not_leak_the_title_into_the_audit_trail(client, db_session):
    """Regression: this endpoint used to log meeting.title into AuditLog.detail
    before erasing the meeting -- since AuditLog has no FK back to the meeting
    for a later scrub to find, that copy would outlive the "irreversible, no
    undo" delete it was recording. The meeting's title (a real, potentially
    identifying string) must never appear anywhere in the audit trail."""
    org, meeting, _session = _seed_meeting(db_session)
    assert meeting.title == "Standup"

    client.delete(f"/api/v1/orgs/{org.id}/meetings/{meeting.id}")

    from sqlalchemy import select

    from app.db.models import AuditLog

    audit = db_session.execute(select(AuditLog).where(AuditLog.org_id == org.id)).scalars().all()
    for entry in audit:
        assert "title" not in entry.detail
        assert "Standup" not in str(entry.detail)


def test_delete_meeting_404_for_unknown_meeting(client, db_session):
    org = Org(name="Acme")
    db_session.add(org)
    db_session.commit()

    resp = client.delete(f"/api/v1/orgs/{org.id}/meetings/does-not-exist")

    assert resp.status_code == 404


def test_get_org_settings_defaults(client, db_session):
    org = Org(name="Acme")
    db_session.add(org)
    db_session.commit()

    resp = client.get(f"/api/v1/orgs/{org.id}/settings")

    assert resp.status_code == 200
    assert resp.json() == {"org_id": org.id, "retention_days": None, "join_policy": "all"}


def test_update_org_settings_sets_retention_days(client, db_session):
    org = Org(name="Acme")
    db_session.add(org)
    db_session.commit()

    resp = client.patch(
        f"/api/v1/orgs/{org.id}/settings",
        json={"retention_days": 90, "retention_days_set": True},
    )

    assert resp.status_code == 200
    assert resp.json()["retention_days"] == 90
    db_session.refresh(org)
    assert org.retention_days == 90

    from sqlalchemy import select

    from app.db.models import AuditLog

    audit = db_session.execute(select(AuditLog).where(AuditLog.org_id == org.id)).scalars().all()
    assert any(a.event == "org_retention_updated" for a in audit)


def test_update_org_settings_clears_retention_days_to_keep_forever(client, db_session):
    org = Org(name="Acme", retention_days=30)
    db_session.add(org)
    db_session.commit()

    resp = client.patch(
        f"/api/v1/orgs/{org.id}/settings",
        json={"retention_days": None, "retention_days_set": True},
    )

    assert resp.status_code == 200
    assert resp.json()["retention_days"] is None
    db_session.refresh(org)
    assert org.retention_days is None


def test_update_org_settings_rejects_non_positive_retention(client, db_session):
    org = Org(name="Acme")
    db_session.add(org)
    db_session.commit()

    resp = client.patch(
        f"/api/v1/orgs/{org.id}/settings",
        json={"retention_days": 0, "retention_days_set": True},
    )

    assert resp.status_code == 400


def test_update_org_settings_noop_without_retention_days_set(client, db_session):
    org = Org(name="Acme", retention_days=30)
    db_session.add(org)
    db_session.commit()

    resp = client.patch(f"/api/v1/orgs/{org.id}/settings", json={})

    assert resp.status_code == 200
    assert resp.json()["retention_days"] == 30
