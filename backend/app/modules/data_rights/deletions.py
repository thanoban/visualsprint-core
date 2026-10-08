"""Hide -> durable stop -> verified external cleanup -> dependency-ordered purge.

Cleanup failures keep the tombstone and a retryable receipt. An acknowledged
DELETE is never labelled proof that primary artifacts or backups are gone.
"""

from collections.abc import Callable
from datetime import UTC, datetime

from sqlalchemy import Table, delete, or_, select, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.capture.commands import stop_capture
from app.capture.dispatcher import CaptureProviderResolver
from app.db.base import Base
from app.db.models import (
    AnswerCitation,
    AsyncJobStatus,
    AudioTrack,
    BotSession,
    BotStatus,
    CalendarConnection,
    CaptureAttempt,
    CaptureAttemptState,
    CaptureMediaRef,
    CaptureRequest,
    CaptureRequestStatus,
    CaptureSession,
    ChatMessage,
    ChatThread,
    DeletionJob,
    ExportJob,
    Keyframe,
    Meeting,
    MeetingAssignment,
    MessageState,
    Org,
    OrgConnection,
    OutboxEvent,
    Person,
    PersonAnalysisRun,
    Project,
    ProjectMember,
    ProviderBinding,
    SummaryVersion,
)
from app.infrastructure.jobs.leases import Claim, claim_next, finish, owned_event
from app.interfaces.blobstore import BlobStore
from app.interfaces.capture_provider import CaptureProviderError, CaptureReference
from app.interfaces.secretstore import SecretStore


class CleanupPending(Exception):
    pass


def remember_cleanup(sessions: Callable[[], Session], claim: Claim, kind: str, ref: str) -> None:
    with sessions() as db:
        event = owned_event(db, claim)
        job = db.get(DeletionJob, claim.entity_id)
        if event is None or job is None:
            raise CleanupPending("deletion_worker_ownership_changed")
        progress = dict(job.cleanup_progress)
        progress[kind] = list(dict.fromkeys([*progress.get(kind, []), ref]))
        job.cleanup_progress = progress
        db.commit()


def accept_deletion(db: Session, job: DeletionJob) -> None:
    org = db.scalar(select(Org).where(Org.id == job.org_id).with_for_update())
    if org is None:
        raise CleanupPending("deletion_scope_missing")
    query = select(Meeting).where(Meeting.org_id == job.org_id)
    if job.scope_kind == "project":
        project = db.scalar(
            select(Project)
            .where(Project.org_id == job.org_id, Project.id == job.scope_id)
            .with_for_update()
        )
        if project is None:
            raise CleanupPending("deletion_scope_missing")
        project.deleted_at = datetime.now(UTC)
        query = query.where(
            Meeting.id.in_(
                select(MeetingAssignment.meeting_id).where(
                    MeetingAssignment.org_id == job.org_id,
                    MeetingAssignment.project_id == job.scope_id,
                )
            )
        )
        db.execute(
            delete(ProjectMember).where(
                ProjectMember.org_id == job.org_id, ProjectMember.project_id == job.scope_id
            )
        )
    else:
        org.deleted_at = datetime.now(UTC)
        org.capture_policy = "off"
        db.execute(
            update(Project).where(Project.org_id == job.org_id).values(deleted_at=datetime.now(UTC))
        )
        db.execute(
            update(CalendarConnection)
            .where(CalendarConnection.org_id == job.org_id)
            .values(enabled=False)
        )
    meetings = list(db.scalars(query.with_for_update().limit(10001)))
    if len(meetings) > 10000:
        raise CleanupPending("deletion_scope_too_large")
    job.target_meeting_ids = [meeting.id for meeting in meetings]
    for meeting in meetings:
        meeting.deleted_at = datetime.now(UTC)
    for request in db.scalars(
        select(CaptureRequest)
        .where(
            CaptureRequest.org_id == job.org_id,
            CaptureRequest.meeting_id.in_(job.target_meeting_ids),
        )
        .with_for_update()
    ):
        if request.status not in {
            CaptureRequestStatus.FINALIZED,
            CaptureRequestStatus.FAILED,
            CaptureRequestStatus.CANCELLED,
        }:
            stop_capture(db, request)
    # Cached exports may contain deleted text. Removing this cache does not erase other meetings.
    db.execute(
        update(ExportJob)
        .where(ExportJob.org_id == job.org_id)
        .values(manifest=None, download_url=None)
    )


def _conditions(table: Table, selected: dict[str, set[str]]) -> list[ColumnElement[bool]]:
    conditions: list[ColumnElement[bool]] = []
    if "id" in table.c and selected.get(table.name):
        conditions.append(table.c.id.in_(selected[table.name]))
    for foreign in table.foreign_keys:
        parent = foreign.column.table.name
        if foreign.column.name == "id" and selected.get(parent):
            conditions.append(foreign.parent.in_(selected[parent]))
    return conditions


def purge_primary(db: Session, job: DeletionJob, event_id: str) -> None:
    # Resolve the FK closure before deleting any rows. Tenant filtering applies at
    # every step; polymorphic/cache relationships are handled explicitly below.
    selected: dict[str, set[str]] = {"meeting": set(job.target_meeting_ids)}
    if job.scope_kind == "workspace":
        selected["org"] = {job.org_id}
    else:
        selected["project"] = {job.scope_id}
        selected["chat_thread"] = set(
            db.scalars(
                select(ChatThread.id).where(
                    ChatThread.org_id == job.org_id,
                    ChatThread.scope_kind == "project",
                    ChatThread.scope_id == job.scope_id,
                )
            )
        )
    excluded = {
        "org",
        "app_user",
        "deletion_job",
        "outbox_event",
        "landing_lead",
        "worker_sweep_state",
    }
    tables = list(Base.metadata.sorted_tables)
    for _ in range(len(tables)):
        changed = False
        for table in tables:
            if table.name in excluded or "id" not in table.c:
                continue
            conditions = _conditions(table, selected)
            if not conditions:
                continue
            query = select(table.c.id).where(or_(*conditions))
            if "org_id" in table.c:
                query = query.where(table.c.org_id == job.org_id)
            found = set(db.scalars(query.limit(100001)))
            if len(found) > 100000:
                raise CleanupPending("deletion_row_limit")
            previous = selected.setdefault(table.name, set())
            if found - previous:
                previous.update(found)
                changed = True
        if not changed:
            break
    affected_messages = select(AnswerCitation.message_id).where(
        AnswerCitation.org_id == job.org_id, AnswerCitation.meeting_id.in_(job.target_meeting_ids)
    )
    db.execute(
        update(ChatMessage)
        .where(ChatMessage.id.in_(affected_messages))
        .values(
            content="Source removed. Ask again using current evidence.", state=MessageState.FAILED
        )
    )
    if job.scope_kind == "project":
        for summary in db.scalars(
            select(SummaryVersion).where(SummaryVersion.org_id == job.org_id)
        ):
            if (summary.scope_kind == "project" and summary.scope_id == job.scope_id) or (
                set(summary.source_meeting_ids) & set(job.target_meeting_ids)
            ):
                db.delete(summary)
        # Legacy person aggregates/voiceprints lack reliable reader-specific source
        # provenance. Invalidate derived caches rather than retain erased facts.
        runs = set(
            db.scalars(select(PersonAnalysisRun.id).where(PersonAnalysisRun.org_id == job.org_id))
        )
        if runs:
            selected["person_analysis_run"] = runs
            from app.db.models import LongitudinalFinding

            db.execute(delete(LongitudinalFinding).where(LongitudinalFinding.org_id == job.org_id))
        db.execute(
            update(Person)
            .where(Person.org_id == job.org_id)
            .values(voiceprint=None, voiceprint_sample_count=0, voiceprint_reliable=False)
        )
    db.flush()
    for table in reversed(tables):
        if table.name in excluded:
            continue
        conditions = _conditions(table, selected)
        if conditions:
            command = delete(table).where(or_(*conditions))
            if "org_id" in table.c:
                command = command.where(table.c.org_id == job.org_id)
            db.execute(command)
    # Outbox uses polymorphic entity IDs, not FKs. Delete affected pending work,
    # but keep the current fenced deletion event and other deletion receipts.
    entity_ids = set().union(*selected.values())
    predicate = OutboxEvent.org_id == job.org_id
    if job.scope_kind != "workspace":
        predicate = predicate & OutboxEvent.entity_id.in_(entity_ids)
    db.execute(
        delete(OutboxEvent).where(
            predicate, OutboxEvent.id != event_id, OutboxEvent.operation != "data.delete"
        )
    )
    if job.scope_kind == "workspace":
        org = db.get(Org, job.org_id)
        if org:
            org.name, org.settings = "Deleted workspace", {}
            org.disclosure_ack_at, org.disclosure_ack_by = None, None


async def delete_next(
    sessions: Callable[[], Session],
    *,
    worker_id: str,
    blob_store: BlobStore,
    secret_store: SecretStore,
    provider_resolver: CaptureProviderResolver,
) -> bool:
    claim = claim_next(sessions, "data.delete", worker_id)
    if claim is None:
        return False
    references: list[tuple[str, CaptureReference]] = []
    blobs: set[str] = set()
    secrets: set[str] = set()
    media: list[tuple[str, str, str]] = []
    verified_media: set[str] = set()
    verified_providers: set[str] = set()
    error: str | None = None
    with sessions() as db:
        event = owned_event(db, claim)
        job = db.get(DeletionJob, claim.entity_id)
        if event is None or job is None:
            return True
        if job.status == AsyncJobStatus.DONE:
            finish(event)
            db.commit()
            return True
        job.status, job.error = AsyncJobStatus.RUNNING, None
        verified_media = set(job.cleanup_progress.get("media", []))
        verified_providers = set(job.cleanup_progress.get("provider", []))
        requests = list(
            db.scalars(
                select(CaptureRequest).where(
                    CaptureRequest.org_id == job.org_id,
                    CaptureRequest.meeting_id.in_(job.target_meeting_ids),
                )
            )
        )
        for request in requests:
            secrets.add(request.meeting_url_secret_ref)
            attempts = list(
                db.scalars(select(CaptureAttempt).where(CaptureAttempt.request_id == request.id))
            )
            for attempt in attempts:
                if attempt.state not in {CaptureAttemptState.ENDED, CaptureAttemptState.FAILED}:
                    error = "deletion_waiting_for_capture_stop"
                if attempt.provider_record_id:
                    references.append(
                        (
                            attempt.provider_binding_id,
                            CaptureReference(
                                provider="vexa",
                                record_id=attempt.provider_record_id,
                                platform=request.platform,
                                native_meeting_id=request.native_meeting_id,
                            ),
                        )
                    )
                elif request.status not in {
                    CaptureRequestStatus.CANCELLED,
                    CaptureRequestStatus.FAILED,
                }:
                    error = "deletion_dispatch_unresolved"
        legacy = db.scalar(
            select(BotSession.id)
            .where(
                BotSession.org_id == job.org_id,
                BotSession.meeting_id.in_(job.target_meeting_ids),
                BotSession.status.not_in(
                    {BotStatus.ENDED, BotStatus.FAILED, BotStatus.MISSED, BotStatus.LOBBY_TIMEOUT}
                ),
            )
            .limit(1)
        )
        if legacy:
            error = "deletion_legacy_capture_requires_stop"
        sessions_ids = list(
            db.scalars(
                select(CaptureSession.id).where(
                    CaptureSession.org_id == job.org_id,
                    CaptureSession.meeting_id.in_(job.target_meeting_ids),
                )
            )
        )
        blobs.update(
            db.scalars(
                select(AudioTrack.uri).where(AudioTrack.capture_session_id.in_(sessions_ids))
            )
        )
        blobs.update(
            db.scalars(
                select(Keyframe.image_uri).where(Keyframe.capture_session_id.in_(sessions_ids))
            )
        )
        blobs.update(
            value
            for value in db.scalars(
                select(CaptureSession.video_uri).where(CaptureSession.id.in_(sessions_ids))
            )
            if value
        )
        # Media locator protocols must be qualified, not erased as though deleting
        # the SecretStore entry itself deleted an audio object.
        for artifact in db.scalars(
            select(CaptureMediaRef).where(
                CaptureMediaRef.org_id == job.org_id,
                CaptureMediaRef.request_id.in_([request.id for request in requests]),
            )
        ):
            media.append((artifact.kind.value, artifact.store_ref, artifact.id))
        if job.scope_kind == "workspace":
            for binding in db.scalars(
                select(ProviderBinding).where(ProviderBinding.org_id == job.org_id)
            ):
                secrets.update({binding.endpoint_ref, binding.secret_ref})
            secrets.update(
                db.scalars(
                    select(CalendarConnection.secret_ref).where(
                        CalendarConnection.org_id == job.org_id
                    )
                )
            )
            secrets.update(
                db.scalars(
                    select(OrgConnection.secret_ref).where(OrgConnection.org_id == job.org_id)
                )
            )
        # Old revisions sometimes shared a URL/credential reference. Do not
        # revoke credentials still needed by another retained scope.
        for ref in list(secrets):
            if db.scalar(
                select(CaptureRequest.id)
                .where(
                    CaptureRequest.meeting_url_secret_ref == ref,
                    CaptureRequest.meeting_id.not_in(job.target_meeting_ids),
                )
                .limit(1)
            ):
                secrets.discard(ref)
            retained_scope = None if job.scope_kind == "project" else job.org_id
            for model in (CalendarConnection, OrgConnection, ProviderBinding):
                condition = model.secret_ref == ref
                if model is ProviderBinding:
                    condition = or_(condition, model.endpoint_ref == ref)
                query = select(model.id).where(condition)
                if retained_scope is not None:
                    query = query.where(model.org_id != retained_scope)
                if db.scalar(query.limit(1)):
                    secrets.discard(ref)
        db.commit()  # No SQL transaction remains open during provider/storage I/O.
    if not error:
        try:
            for binding_id, reference in references:
                identity = f"{binding_id}:{reference.record_id}"
                if identity in verified_providers:
                    continue
                with sessions() as db:
                    resolved_binding = db.get(ProviderBinding, binding_id)
                    if resolved_binding is None or resolved_binding.org_id != claim.org_id:
                        raise CleanupPending("deletion_provider_binding_missing")
                    db.expunge(resolved_binding)
                provider = await provider_resolver.resolve(resolved_binding)
                await provider.delete_artifacts(reference)
                try:
                    await provider.transcript(reference)
                except CaptureProviderError as exc:
                    if exc.code != "vexa_http_404":
                        raise
                else:
                    raise CleanupPending("deletion_provider_erasure_unverified")
                remember_cleanup(sessions, claim, "provider", identity)
            for uri in blobs:
                await blob_store.delete(uri)
                if await blob_store.exists(uri):
                    raise CleanupPending("deletion_blob_erasure_unverified")
            for kind, ref, artifact_id in media:
                if artifact_id in verified_media:
                    secrets.add(ref)
                    continue
                if kind == "provider_recording":
                    if not references:
                        raise CleanupPending("deletion_provider_record_identity_missing")
                    # All provider records above were independently checked erased.
                else:
                    try:
                        locator = await secret_store.get(ref)
                    except KeyError as exc:
                        raise CleanupPending("deletion_media_locator_missing") from exc
                    if not locator.startswith(("blob://", "gs://", "s3://")):
                        raise CleanupPending("deletion_media_locator_unsupported")
                    await blob_store.delete(locator)
                    if await blob_store.exists(locator):
                        raise CleanupPending("deletion_media_erasure_unverified")
                remember_cleanup(sessions, claim, "media", artifact_id)
                secrets.add(ref)
            for ref in secrets:
                await secret_store.delete(ref)
                try:
                    await secret_store.get(ref)
                except KeyError:
                    pass
                else:
                    raise CleanupPending("deletion_secret_erasure_unverified")
        except CleanupPending as exc:
            error = str(exc)
        except Exception:
            error = "deletion_external_cleanup_failed"  # No vendor bodies/locators in receipts.
    with sessions() as db:
        event = owned_event(db, claim)
        job = db.get(DeletionJob, claim.entity_id)
        if event is None or job is None:
            return True
        if not error:
            try:
                purge_primary(db, job, event.id)
            except (CleanupPending, SQLAlchemyError) as exc:
                db.rollback()
                error = (
                    str(exc)
                    if isinstance(exc, CleanupPending)
                    else "deletion_database_cleanup_failed"
                )
                event = owned_event(db, claim)
                job = db.get(DeletionJob, claim.entity_id)
                if event is None or job is None:
                    return True
        if error:
            retry = event.attempts < event.max_attempts
            job.status, job.error = (
                (AsyncJobStatus.PENDING if retry else AsyncJobStatus.FAILED),
                error,
            )
            finish(event, error, retry=retry)
        else:
            job.status, job.completed_at = AsyncJobStatus.DONE, datetime.now(UTC)
            finish(event)
        db.commit()
    return True
