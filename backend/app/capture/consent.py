"""Disclosure/consent recording — shared by every capture mode.

docs/03-capture.md: "Disclosure always: named participant, chat announcement,
logged consent record. No stealth capture under any framing." Modes D and A2
disclose differently (uploader attestation vs. the platform's own recording
indicator), but every capture_session must end up with a ConsentRecord and a
matching disclosure_log entry — there is no mode exempt from this.

Idempotent: re-running acquire after a crash must not accumulate duplicate
records, so this clears any prior records for the session before writing.
"""

from datetime import UTC, datetime

from app.db.models import CaptureSession, ConsentRecord


def record_disclosure(db: object, session: CaptureSession, subject: str, method: str, detail: str) -> None:
    db.query(ConsentRecord).filter(ConsentRecord.capture_session_id == session.id).delete()

    db.add(
        ConsentRecord(
            org_id=session.org_id,
            capture_session_id=session.id,
            subject=subject,
            method=method,
            detail=detail,
        )
    )
    session.disclosure_log = [
        {
            "subject": subject,
            "method": method,
            "detail": detail,
            "at": datetime.now(UTC).isoformat(),
        }
    ]
