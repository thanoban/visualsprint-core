"""Shared persistence for `CaptureArtifacts` (app/interfaces/platform.py) --
turns roster entries, audio tracks, and speaker labels into `Participant`,
`AudioTrack`, and `PlatformSpeakerLabel` rows.

Lives in `app/capture/`, not `app/orchestrator/worker.py` where this used to
be defined, so both the ordinary pipeline (`worker._handle_acquire`, Mode
A2) and the RTMS webhook (`app/api/rtms_webhook.py`, Mode A1 -- which
receives its artifacts over a live websocket, not a `PipelineJob`, and so
never goes through `_handle_acquire` at all) can call the same function
instead of one of them hand-rolling a second copy. `worker.py` importing
from `app/api/` would be the backwards direction (orchestrator depending on
the API layer); this module is capture-layer, same as the platform adapters
whose output it consumes, so both callers importing it is the correct
direction either way.
"""

from app.interfaces.platform import CaptureArtifacts


def _person_for_roster_entry(db: object, org_id: str, entry):
    from sqlalchemy import select

    from app.db.models import Person

    if entry.email:
        existing = db.execute(
            select(Person).where(Person.org_id == org_id, Person.email == entry.email).limit(1)
        ).scalar_one_or_none()
        if existing:
            return existing

    existing = db.execute(
        select(Person)
        .where(Person.org_id == org_id, Person.display_name == entry.display_name)
        .limit(1)
    ).scalar_one_or_none()
    if existing:
        if entry.email and not existing.email:
            existing.email = entry.email
        return existing

    person = Person(
        org_id=org_id,
        display_name=entry.display_name,
        email=entry.email,
        aliases=[entry.display_name],
    )
    db.add(person)
    db.flush()
    return person


def persist_capture_artifacts(db: object, session, artifacts: CaptureArtifacts) -> None:
    from app.db.models import AudioTrack, Participant, PlatformSpeakerLabel

    participant_by_key = {}
    for entry in artifacts.roster:
        person = _person_for_roster_entry(db, session.org_id, entry)
        participant = Participant(
            org_id=session.org_id,
            capture_session_id=session.id,
            person_id=person.id,
            display_name=entry.display_name,
            platform_user_id=entry.platform_user_id,
        )
        db.add(participant)
        for key in (entry.email, entry.platform_user_id, entry.display_name):
            if key:
                participant_by_key[key] = participant
    db.flush()

    for track in artifacts.audio_tracks:
        person_id = None
        display_name = None
        if track.participant:
            display_name = track.participant.display_name
            participant = next(
                (
                    participant_by_key[key]
                    for key in (
                        track.participant.email,
                        track.participant.platform_user_id,
                        track.participant.display_name,
                    )
                    if key and key in participant_by_key
                ),
                None,
            )
            if participant is None:
                person = _person_for_roster_entry(db, session.org_id, track.participant)
                participant = Participant(
                    org_id=session.org_id,
                    capture_session_id=session.id,
                    person_id=person.id,
                    display_name=track.participant.display_name,
                    platform_user_id=track.participant.platform_user_id,
                )
                db.add(participant)
                db.flush()
            person_id = participant.person_id

        db.add(
            AudioTrack(
                org_id=session.org_id,
                capture_session_id=session.id,
                uri=track.uri,
                participant_person_id=person_id,
                participant_display_name=display_name,
            )
        )

    for label in artifacts.speaker_labels:
        db.add(
            PlatformSpeakerLabel(
                org_id=session.org_id,
                capture_session_id=session.id,
                start_s=label.start_s,
                end_s=label.end_s,
                display_name=label.display_name,
                provider=artifacts.mode.value,
            )
        )

    session.video_uri = artifacts.screen_share_uri or artifacts.video_uri

    if artifacts.preextracted_keyframes:
        from app.db.models import Keyframe

        frames = artifacts.preextracted_keyframes
        for i, frame in enumerate(frames):
            valid_to = frames[i + 1].timestamp_s if i + 1 < len(frames) else frame.timestamp_s + 5.0
            db.add(
                Keyframe(
                    org_id=session.org_id,
                    capture_session_id=session.id,
                    valid_from_s=frame.timestamp_s,
                    valid_to_s=valid_to,
                    image_uri=frame.image_uri,
                )
            )
