"""Calendar snapshots schedule one durable capture lane, never legacy transports."""

import hashlib
import re
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.capture.commands import stop_capture
from app.capture.requests import (
    CaptureMinuteLimitError,
    CapturePolicyError,
    CaptureRequestScopeError,
    create_capture_request,
)
from app.db.models import (
    BotSession,
    CalendarConnection,
    CalendarOccurrence,
    CalendarOccurrenceStatus,
    CaptureRequest,
    CaptureRequestStatus,
    CaptureSession,
    Meeting,
    Org,
    OrgMember,
)
from app.interfaces.calendar import CalendarEvent
from app.interfaces.capture_provider import MeetingTarget
from app.interfaces.secretstore import SecretStore

_TERMINAL = {
    CaptureRequestStatus.CANCELLED,
    CaptureRequestStatus.FAILED,
    CaptureRequestStatus.FINALIZED,
}


def utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def event_target(event: CalendarEvent) -> MeetingTarget | None:
    for candidate in re.findall(r"https://[^\s<>\"']+", event.conferencing_text):
        try:
            return MeetingTarget.from_url(candidate.rstrip(".,);]"))
        except ValueError:
            continue
    return None


def allowed(org: Org, event: CalendarEvent) -> bool:
    return (
        (org.join_policy == "organized_only" and event.is_organizer)
        or (org.join_policy == "never_private" and event.visibility != "private")
        or org.join_policy == "all"
    )


def enabled(org: Org, occurrence: CalendarOccurrence) -> bool:
    return (
        org.disclosure_ack_at is not None
        and org.capture_policy in {"manual", "calendar"}
        and occurrence.capture_override != "off"
        and (org.capture_policy == "calendar" or occurrence.capture_override == "on")
    )


def requests_for(db: Session, occurrence: CalendarOccurrence) -> list[CaptureRequest]:
    if not occurrence.meeting_id:
        return []
    return list(
        db.scalars(
            select(CaptureRequest)
            .where(
                CaptureRequest.org_id == occurrence.org_id,
                CaptureRequest.meeting_id == occurrence.meeting_id,
            )
            .order_by(CaptureRequest.created_at.desc(), CaptureRequest.id.desc())
        )
    )


async def discard_unused_urls(db: Session, secrets: SecretStore, written: set[str]) -> None:
    unused = [
        ref
        for ref in written
        if db.scalar(
            select(CaptureRequest.id).where(CaptureRequest.meeting_url_secret_ref == ref).limit(1)
        )
        is None
    ]
    db.commit()
    for ref in unused:
        await secrets.delete(ref)


async def sync_snapshot(
    db: Session,
    connection: CalendarConnection,
    events: list[CalendarEvent],
    secrets: SecretStore,
    *,
    within: timedelta,
    now: datetime | None = None,
) -> list[str]:
    timestamp = now or datetime.now(UTC)
    org_id, connection_id = connection.org_id, connection.id
    prepared: dict[str, tuple[MeetingTarget, str]] = {}
    initial = db.get(Org, org_id)
    if initial is None or initial.deleted_at is not None or not connection.enabled:
        return []
    owner_verified = (
        connection.owner_user_id is not None
        and db.scalar(
            select(OrgMember.id).where(
                OrgMember.org_id == org_id, OrgMember.user_id == connection.owner_user_id
            )
        )
        is not None
    )
    overrides: dict[str, str | None] = {
        event_id: value
        for event_id, value in db.execute(
            select(CalendarOccurrence.provider_event_id, CalendarOccurrence.capture_override).where(
                CalendarOccurrence.connection_id == connection_id
            )
        ).all()
    }
    eligible = {
        event.external_event_id
        for event in events
        if owner_verified
        and allowed(initial, event)
        and initial.disclosure_ack_at is not None
        and initial.capture_policy in {"manual", "calendar"}
        and overrides.get(event.external_event_id) != "off"
        and (initial.capture_policy == "calendar" or overrides.get(event.external_event_id) == "on")
    }
    written: set[str] = set()
    # Release the adapter's read transaction before SecretStore I/O.
    db.commit()
    for event in events:
        target = event_target(event)
        if target is None:
            continue
        digest = hashlib.sha256(target.meeting_url.encode()).hexdigest()
        event_digest = hashlib.sha256(event.external_event_id.encode()).hexdigest()[:24]
        ref = f"calendar-url/{org_id}/{connection_id}/{event_digest}/{digest}"
        if event.external_event_id in eligible:
            await secrets.put(ref, target.meeting_url)
            written.add(ref)
        prepared[event.external_event_id] = target, ref

    org = db.scalar(
        select(Org)
        .where(Org.id == org_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    current = db.scalar(
        select(CalendarConnection)
        .where(CalendarConnection.id == connection_id, CalendarConnection.org_id == org_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if (
        org is None
        or org.deleted_at is not None
        or current is None
        or not current.enabled
        or not org.pilot_features_enabled
    ):
        db.rollback()
        await discard_unused_urls(db, secrets, written)
        return []
    actor = current.owner_user_id
    owned = (
        actor is not None
        and db.scalar(
            select(OrgMember.id).where(OrgMember.org_id == org_id, OrgMember.user_id == actor)
        )
        is not None
    )
    created: list[str] = []
    seen = {event.external_event_id for event in events}
    for event in events:
        occurrence = db.scalar(
            select(CalendarOccurrence)
            .where(
                CalendarOccurrence.connection_id == connection_id,
                CalendarOccurrence.provider_event_id == event.external_event_id,
            )
            .with_for_update()
        )
        pair = prepared.get(event.external_event_id)
        target, ref = pair if pair else (None, "")
        is_new = occurrence is None
        if occurrence is None:
            occurrence = CalendarOccurrence(
                org_id=org_id,
                connection_id=connection_id,
                provider_event_id=event.external_event_id,
                original_start=event.start_at,
                start_time=event.start_at,
                end_time=event.end_at,
                title=event.title,
            )
            db.add(occurrence)
            db.flush()
        previous = requests_for(db, occurrence)
        changed = (
            utc(occurrence.start_time) != utc(event.start_at)
            or utc(occurrence.end_time) != utc(event.end_at)
            or (target is not None and occurrence.platform_meeting_id != target.native_meeting_id)
            or (bool(previous) and bool(ref) and previous[0].meeting_url_secret_ref != ref)
            or occurrence.status == CalendarOccurrenceStatus.CANCELLED
        )
        if changed and not is_new:
            occurrence.revision += 1
        occurrence.start_time, occurrence.end_time = event.start_at, event.end_at
        occurrence.title = event.title
        occurrence.status = CalendarOccurrenceStatus.SCHEDULED
        occurrence.platform = target.platform if target else None
        occurrence.platform_meeting_id = target.native_meeting_id if target else None
        occurrence.capture_error = None
        qualifies = allowed(org, event) and enabled(org, occurrence) and target is not None
        if not owned:
            occurrence.capture_error = "calendar_owner_reconnect_required"
            qualifies = False
        for request in previous:
            if request.status not in _TERMINAL and (
                not qualifies or (changed and request.status == CaptureRequestStatus.QUEUED)
            ):
                stop_capture(db, request)
        if not qualifies:
            continue
        assert target is not None and actor is not None
        if any(request.status not in _TERMINAL for request in previous):
            continue  # Never replace a dispatched/uncertain/live occurrence on reschedule.
        if utc(event.end_at) <= timestamp:
            continue  # An estimate is not an end signal for an already active call.
        if ref not in written:
            occurrence.capture_error = "calendar_policy_changed_retry_sync"
            continue
        if (
            previous
            and previous[0].status in {CaptureRequestStatus.FINALIZED, CaptureRequestStatus.FAILED}
            and not changed
        ):
            continue  # Do not auto-restart a stopped/failed occurrence.
        if previous and previous[0].status == CaptureRequestStatus.CANCELLED:
            occurrence.revision = max(
                occurrence.revision,
                int(previous[0].policy_snapshot.get("occurrence_revision", 0)) + 1,
            )
        meeting = db.get(Meeting, occurrence.meeting_id) if occurrence.meeting_id else None
        if meeting is not None and (
            meeting.owner_user_id != actor
            or db.scalar(
                select(CaptureSession.id).where(CaptureSession.meeting_id == meeting.id).limit(1)
            )
            or db.scalar(select(BotSession.id).where(BotSession.meeting_id == meeting.id).limit(1))
        ):
            occurrence.capture_error = "legacy_capture_requires_drain"
            continue
        if meeting is None:
            meeting = Meeting(
                org_id=org_id,
                owner_user_id=actor,
                platform=target.platform,
                platform_meeting_id=target.native_meeting_id,
                title=event.title,
                external_calendar_event_id=event.external_event_id,
                scheduled_start=event.start_at,
                scheduled_end=event.end_at,
            )
            db.add(meeting)
            db.flush()
            occurrence.meeting_id = meeting.id
        else:
            meeting.scheduled_start, meeting.scheduled_end = event.start_at, event.end_at
            meeting.platform, meeting.platform_meeting_id, meeting.title = (
                target.platform,
                target.native_meeting_id,
                event.title,
            )
        seconds = max(1, min(14400, int((utc(event.end_at) - utc(event.start_at)).total_seconds())))
        try:
            result = create_capture_request(
                db,
                org_id=org_id,
                meeting_id=meeting.id,
                requested_by=actor,
                idempotency_key=f"calendar:{occurrence.id}:{occurrence.revision}",
                target=target,
                meeting_url_secret_ref=ref,
                policy_snapshot={
                    "occurrence_id": occurrence.id,
                    "occurrence_revision": occurrence.revision,
                    "language": "en",
                },
                estimated_seconds=seconds,
                now=timestamp,
                run_at=max(timestamp, utc(event.start_at)),
            )
            if result.created:
                created.append(result.request.id)
        except CaptureMinuteLimitError:
            occurrence.capture_error = "capture_monthly_limit"
        except CapturePolicyError:
            occurrence.capture_error = "capture_policy_disabled"
        except CaptureRequestScopeError:
            occurrence.capture_error = "capture_owner_access_changed"
    missing = db.scalars(
        select(CalendarOccurrence).where(
            CalendarOccurrence.connection_id == connection_id,
            CalendarOccurrence.status == CalendarOccurrenceStatus.SCHEDULED,
            CalendarOccurrence.start_time > timestamp,
            CalendarOccurrence.start_time <= timestamp + within,
            CalendarOccurrence.provider_event_id.not_in(seen),
        )
    )
    for occurrence in missing:
        occurrence.status = CalendarOccurrenceStatus.CANCELLED
        occurrence.revision += 1
        for request in requests_for(db, occurrence):
            if request.status not in _TERMINAL:
                stop_capture(db, request)
    db.commit()
    # Refuse/quota/cancel snapshots must not leave invitation secrets with no owner.
    await discard_unused_urls(db, secrets, written)
    return created
