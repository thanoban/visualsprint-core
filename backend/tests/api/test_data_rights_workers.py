"""Safe fixture-only export and deletion recovery through real HTTP/jobs."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import sessionmaker

from app.db.models import (
    AsyncJobStatus,
    AudioTrack,
    DeletionJob,
    ExportJob,
    Meeting,
    Org,
    OutboxEvent,
    Project,
    ProjectMember,
    User,
)
from app.modules.data_rights.deletions import delete_next
from app.modules.data_rights.exports import export_next
from tests.api.test_saved_chat_worker import ACTOR

pytest_plugins = ["tests.api.test_saved_chat_worker"]


class Storage:
    def __init__(self):
        self.values = {}
        self.fail = False

    async def delete(self, key):
        if self.fail:
            raise RuntimeError("private-vendor-body")
        self.values.pop(key, None)

    async def exists(self, key):
        return key in self.values

    async def get(self, key):
        return self.values[key]

    async def put(self, key, value):
        self.values[key] = value


class Resolver:
    async def resolve(self, binding):
        raise AssertionError("No fixture capture was dispatched; provider I/O forbidden")


def sessions(db):
    return sessionmaker(bind=db.bind, expire_on_commit=False)


def root(chat):
    return chat[-2].split("/threads/")[0]


def test_legacy_rights_cannot_bypass_durable_capture_cleanup(client, chat):
    org, _, meeting, *_ = chat
    path = f"/api/v1/orgs/{org.id}/meetings/{meeting.id}"
    assert client.get(path + "/export").status_code == 409
    assert client.delete(path).status_code == 409


def export(client, db, chat):
    project = chat[1]
    response = client.post(
        root(chat) + "/exports",
        json={"scope_kind": "project", "scope_id": project.id},
        headers={"Idempotency-Key": "export-once"},
    )
    assert response.status_code == 202
    assert export_next(sessions(db), worker_id="rights-test")
    return response.json()["id"]


def test_authenticated_export_covers_text_and_retry_does_not_duplicate(client, db_session, chat):
    identifier = export(client, db_session, chat)
    response = client.get(root(chat) + f"/exports/{identifier}/download")
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store", (
        response.json()
    )
    content = response.json()["meetings"][0]["captures"][0]
    assert content["transcript"][0]["text"] == "We chose Postgres."
    assert content["verified_knowledge"][0]["statement"] == "The team chose Postgres."
    retry = client.post(
        root(chat) + "/exports",
        json={"scope_kind": "project", "scope_id": chat[1].id},
        headers={"Idempotency-Key": "export-once"},
    )
    assert retry.json()["id"] == identifier
    assert db_session.scalar(select(func.count()).select_from(ExportJob)) == 1


def test_export_revocation_and_transcript_correction_block_old_download(client, db_session, chat):
    identifier = export(client, db_session, chat)
    chat[4].text = "Corrected private text"
    db_session.commit()
    assert client.get(root(chat) + f"/exports/{identifier}/download").status_code == 409
    db_session.query(ProjectMember).filter_by(project_id=chat[1].id).delete()
    db_session.commit()
    assert client.get(root(chat) + f"/exports/{identifier}/download").status_code == 404


@pytest.mark.asyncio
async def test_project_hide_then_primary_purge_keeps_other_workspace(client, db_session, chat):
    org, project, meeting, *_ = chat
    org_id, project_id, meeting_id = org.id, project.id, meeting.id
    other = Org(name="Must survive")
    db_session.add(other)
    db_session.flush()
    kept = Meeting(org_id=other.id, owner_user_id=ACTOR, platform="upload", title="Other customer")
    db_session.add(kept)
    db_session.commit()
    response = client.post(
        root(chat) + "/deletions",
        json={"scope_kind": "project", "scope_id": project.id},
        headers={"Idempotency-Key": "delete-once"},
    )
    assert response.status_code == 202
    identifier = response.json()["id"]
    assert client.get(root(chat) + f"/meetings/{meeting.id}").status_code == 404
    assert client.get(chat[-2] + "/messages").status_code == 404
    store = Storage()
    assert await delete_next(
        sessions(db_session),
        worker_id="rights-test",
        blob_store=store,
        secret_store=store,
        provider_resolver=Resolver(),
    )
    assert client.get(root(chat) + f"/deletions/{identifier}").json()["status"] == "done"
    db_session.expire_all()
    assert db_session.get(Meeting, meeting_id) is None
    assert db_session.get(Project, project_id) is None
    assert db_session.get(Meeting, kept.id).title == "Other customer"
    assert db_session.get(Org, org_id) is not None


@pytest.mark.asyncio
async def test_blob_failure_preserves_tombstone_and_retries_with_safe_receipt(
    client, db_session, chat
):
    item = chat[3]
    track = AudioTrack(
        org_id=chat[0].id,
        capture_session_id=item.capture_session_id,
        uri="blob://fixture.wav",
    )
    db_session.add(track)
    db_session.commit()
    response = client.post(
        root(chat) + "/deletions", json={"scope_kind": "project", "scope_id": chat[1].id}
    )
    identifier = response.json()["id"]
    store = Storage()
    store.values["blob://fixture.wav"] = b"fixture"
    store.fail = True
    await delete_next(
        sessions(db_session),
        worker_id="rights-test",
        blob_store=store,
        secret_store=store,
        provider_resolver=Resolver(),
    )
    receipt = client.get(root(chat) + f"/deletions/{identifier}").json()
    assert receipt["status"] == "pending" and receipt["error"] == "deletion_external_cleanup_failed"
    db_session.expire_all()
    assert db_session.get(Meeting, chat[2].id).deleted_at is not None
    store.fail = False
    event = db_session.scalar(select(OutboxEvent).where(OutboxEvent.operation == "data.delete"))
    event.run_at = datetime.now(UTC) - timedelta(seconds=1)
    db_session.commit()
    await delete_next(
        sessions(db_session),
        worker_id="rights-test",
        blob_store=store,
        secret_store=store,
        provider_resolver=Resolver(),
    )
    assert not await store.exists("blob://fixture.wav")
    assert client.get(root(chat) + f"/deletions/{identifier}").json()["status"] == "done"


@pytest.mark.asyncio
async def test_workspace_purge_keeps_only_receipt_and_global_login(client, db_session, chat):
    org_id = chat[0].id
    response = client.post(
        root(chat) + "/deletions",
        json={"scope_kind": "workspace", "scope_id": org_id},
        headers={"Idempotency-Key": "delete-workspace"},
    )
    assert response.status_code == 202
    identifier = response.json()["id"]
    store = Storage()
    await delete_next(
        sessions(db_session),
        worker_id="rights-test",
        blob_store=store,
        secret_store=store,
        provider_resolver=Resolver(),
    )
    assert client.get(root(chat) + f"/deletions/{identifier}").json()["status"] == "done"
    db_session.expire_all()
    assert db_session.get(Org, org_id).name == "Deleted workspace"
    assert db_session.get(User, ACTOR) is not None
    assert db_session.scalar(select(func.count()).select_from(Meeting)) == 0
    assert (
        db_session.scalar(select(DeletionJob).where(DeletionJob.id == identifier)).status
        == AsyncJobStatus.DONE
    )


def captured_request(db, chat):
    from app.capture.requests import create_capture_request
    from app.interfaces.capture_provider import MeetingTarget

    chat[0].capture_policy = "manual"
    chat[0].disclosure_ack_at = datetime.now(UTC)
    target = MeetingTarget.from_url("https://meet.google.com/abc-defg-hij")
    request = create_capture_request(
        db,
        org_id=chat[0].id,
        meeting_id=chat[2].id,
        requested_by=ACTOR,
        idempotency_key="fixture-capture",
        target=target,
        meeting_url_secret_ref="fixture/url",
        policy_snapshot={},
        estimated_seconds=60,
    ).request
    db.commit()
    return request


@pytest.mark.asyncio
async def test_live_capture_must_stop_and_provider_erasure_must_be_verified(
    client, db_session, chat
):
    from app.db.models import (
        CaptureAttempt,
        CaptureAttemptState,
        CaptureRequest,
        CaptureRequestStatus,
        ProviderBinding,
    )
    from app.interfaces.capture_provider import CaptureProviderError

    request = captured_request(db_session, chat)
    binding = ProviderBinding(
        org_id=chat[0].id,
        provider="vexa",
        account_scope_id="fixture",
        endpoint_ref="ep",
        secret_ref="key",
    )
    db_session.add(binding)
    db_session.flush()
    attempt = CaptureAttempt(
        org_id=chat[0].id,
        request_id=request.id,
        attempt_no=1,
        provider_binding_id=binding.id,
        provider_record_id="one-record",
        state=CaptureAttemptState.CAPTURING,
    )
    request.status = CaptureRequestStatus.MONITORING
    db_session.add(attempt)
    db_session.commit()
    identifier = client.post(
        root(chat) + "/deletions", json={"scope_kind": "project", "scope_id": chat[1].id}
    ).json()["id"]
    store = Storage()
    await delete_next(
        sessions(db_session),
        worker_id="test",
        blob_store=store,
        secret_store=store,
        provider_resolver=Resolver(),
    )
    assert (
        client.get(root(chat) + f"/deletions/{identifier}").json()["error"]
        == "deletion_waiting_for_capture_stop"
    )
    db_session.expire_all()
    attempt.state = CaptureAttemptState.ENDED
    request.status = CaptureRequestStatus.FINALIZED
    event = db_session.scalar(select(OutboxEvent).where(OutboxEvent.operation == "data.delete"))
    event.run_at = datetime.now(UTC) - timedelta(seconds=1)
    db_session.commit()

    class Provider:
        erased = False

        async def delete_artifacts(self, ref):
            assert ref.record_id == "one-record"
            self.erased = True

        async def transcript(self, ref):
            raise CaptureProviderError("vexa_http_404")

    provider = Provider()

    class TerminalResolver:
        async def resolve(self, row):
            return provider

    await delete_next(
        sessions(db_session),
        worker_id="test",
        blob_store=store,
        secret_store=store,
        provider_resolver=TerminalResolver(),
    )
    assert provider.erased
    assert client.get(root(chat) + f"/deletions/{identifier}").json()["status"] == "done"
    db_session.expire_all()
    assert db_session.scalar(select(func.count()).select_from(CaptureRequest)) == 0


@pytest.mark.asyncio
async def test_media_locator_is_not_mistaken_for_media_and_survives_cleanup_retry(
    client, db_session, chat, monkeypatch
):
    from app.db.models import CaptureMediaRef, MediaRefKind
    from app.modules.data_rights import deletions

    request = captured_request(db_session, chat)
    artifact = CaptureMediaRef(
        org_id=chat[0].id,
        request_id=request.id,
        kind=MediaRefKind.FULL_AUDIO,
        store_ref="fixture/media-locator",
        delete_after=datetime.now(UTC),
    )
    db_session.add(artifact)
    db_session.commit()
    identifier = client.post(
        root(chat) + "/deletions", json={"scope_kind": "project", "scope_id": chat[1].id}
    ).json()["id"]
    store = Storage()
    store.values.update(
        {
            "fixture/media-locator": "blob://audio.wav",
            "blob://audio.wav": b"private fixture",
            "fixture/url": "private link",
        }
    )
    original = deletions.purge_primary

    def fail_once(*args):
        raise deletions.CleanupPending("fixture_database_retry")

    monkeypatch.setattr(deletions, "purge_primary", fail_once)
    await delete_next(
        sessions(db_session),
        worker_id="test",
        blob_store=store,
        secret_store=store,
        provider_resolver=Resolver(),
    )
    assert "blob://audio.wav" not in store.values and "fixture/media-locator" not in store.values
    monkeypatch.setattr(deletions, "purge_primary", original)
    db_session.expire_all()
    event = db_session.scalar(select(OutboxEvent).where(OutboxEvent.operation == "data.delete"))
    event.run_at = datetime.now(UTC) - timedelta(seconds=1)
    db_session.commit()
    await delete_next(
        sessions(db_session),
        worker_id="test",
        blob_store=store,
        secret_store=store,
        provider_resolver=Resolver(),
    )
    assert client.get(root(chat) + f"/deletions/{identifier}").json()["status"] == "done"


@pytest.mark.asyncio
async def test_workspace_provider_cleanup_checkpoint_survives_credentials_removal(
    client, db_session, chat, monkeypatch
):
    from sqlalchemy.exc import SQLAlchemyError

    from app.db.models import (
        CaptureAttempt,
        CaptureAttemptState,
        CaptureRequestStatus,
        ProviderBinding,
    )
    from app.interfaces.capture_provider import CaptureProviderError
    from app.modules.data_rights import deletions

    request = captured_request(db_session, chat)
    binding = ProviderBinding(
        org_id=chat[0].id,
        provider="vexa",
        account_scope_id="owned",
        endpoint_ref="fixture/endpoint",
        secret_ref="fixture/key",
    )
    db_session.add(binding)
    db_session.flush()
    db_session.add(
        CaptureAttempt(
            org_id=chat[0].id,
            request_id=request.id,
            attempt_no=1,
            provider_binding_id=binding.id,
            provider_record_id="erased",
            state=CaptureAttemptState.ENDED,
        )
    )
    request.status = CaptureRequestStatus.FINALIZED
    # A different workspace intentionally shares only the endpoint configuration.
    retained = Org(name="retained")
    db_session.add(retained)
    db_session.flush()
    db_session.add(
        ProviderBinding(
            org_id=retained.id,
            provider="vexa",
            account_scope_id="retained",
            endpoint_ref="fixture/endpoint",
            secret_ref="retained/key",
        )
    )
    db_session.commit()
    identifier = client.post(
        root(chat) + "/deletions", json={"scope_kind": "workspace", "scope_id": chat[0].id}
    ).json()["id"]
    store = Storage()
    store.values.update(
        {
            "fixture/endpoint": "https://fixture.invalid",
            "fixture/key": "key",
            "retained/key": "retained",
        }
    )

    class Provider:
        async def delete_artifacts(self, ref):
            pass

        async def transcript(self, ref):
            raise CaptureProviderError("vexa_http_404")

    class CheckedResolver:
        calls = 0

        async def resolve(self, binding):
            self.calls += 1
            assert await store.get(binding.secret_ref) == "key"
            return Provider()

    resolver = CheckedResolver()
    original = deletions.purge_primary
    monkeypatch.setattr(
        deletions, "purge_primary", lambda *args: (_ for _ in ()).throw(SQLAlchemyError())
    )
    await delete_next(
        sessions(db_session),
        worker_id="test",
        blob_store=store,
        secret_store=store,
        provider_resolver=resolver,
    )
    assert "fixture/key" not in store.values
    assert store.values["fixture/endpoint"] == "https://fixture.invalid"
    assert store.values["retained/key"] == "retained"
    assert client.get(root(chat) + f"/deletions/{identifier}").json()["status"] == "pending"
    db_session.expire_all()
    event = db_session.scalar(select(OutboxEvent).where(OutboxEvent.operation == "data.delete"))
    event.run_at = datetime.now(UTC) - timedelta(seconds=1)
    db_session.commit()
    monkeypatch.setattr(deletions, "purge_primary", original)
    await delete_next(
        sessions(db_session),
        worker_id="test",
        blob_store=store,
        secret_store=store,
        provider_resolver=resolver,
    )
    assert resolver.calls == 1
    assert client.get(root(chat) + f"/deletions/{identifier}").json()["status"] == "done"
