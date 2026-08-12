"""Deterministic second FSM for person-scoped longitudinal intelligence."""

from __future__ import annotations

import hashlib
import traceback
from datetime import datetime

import structlog
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.agents.claim_auditor import (
    PROMPT_VERSION as AUDITOR_PROMPT_VERSION,
)
from app.agents.claim_auditor import (
    ClaimAuditInput,
    audit_claim,
)
from app.agents.decision_trajectory import (
    PROMPT_VERSION as DECISION_PROMPT_VERSION,
)
from app.agents.decision_trajectory import (
    DecisionTrajectoryInput,
    analyze_decision_trajectory,
)
from app.agents.longitudinal_common import AuditableClaim
from app.agents.participant_narrator import (
    PROMPT_VERSION as NARRATOR_PROMPT_VERSION,
)
from app.agents.participant_narrator import (
    ParticipantNarratorInput,
    narrate_participant,
)
from app.agents.pattern import (
    PROMPT_VERSION as PATTERN_PROMPT_VERSION,
)
from app.agents.pattern import (
    RepetitionCandidateInput,
    analyze_pattern,
)
from app.agents.progress import (
    PROMPT_VERSION as PROGRESS_PROMPT_VERSION,
)
from app.agents.progress import (
    assess_progress,
)
from app.config import get_settings
from app.db.models import (
    ActionStatus,
    Confidence,
    FindingAuditStatus,
    FindingKind,
    KnowledgeType,
    LongitudinalFinding,
    LongitudinalState,
    Person,
    PersonAnalysisRun,
    ProposedAction,
)
from app.interfaces.actions import ActionKind
from app.interfaces.llm import LlmClient
from app.longitudinal.evidence import (
    assemble_person_evidence,
    build_progress_input,
    detect_repetition_candidates,
    validate_grounding,
)

log = structlog.get_logger()

PROMPT_VERSIONS = {
    "decision_trajectory": DECISION_PROMPT_VERSION,
    "pattern": PATTERN_PROMPT_VERSION,
    "progress": PROGRESS_PROMPT_VERSION,
    "claim_auditor": AUDITOR_PROMPT_VERSION,
    "participant_narrator": NARRATOR_PROMPT_VERSION,
}


def _advance(db: Session, run: PersonAnalysisRun, state: LongitudinalState) -> None:
    from app.orchestrator.audit import log_audit_event

    run.state = state
    log_audit_event(
        db,
        org_id=run.org_id,
        actor="system",
        event="longitudinal_state_changed",
        detail={"analysis_run_id": run.id, "person_id": run.person_id, "state": state.value},
    )


def _upsert_run(
    db: Session,
    org_id: str,
    person_id: str,
    period_start: datetime,
    period_end: datetime,
    evidence_hash: str,
) -> tuple[PersonAnalysisRun, bool]:
    run = db.execute(
        select(PersonAnalysisRun).where(
            PersonAnalysisRun.org_id == org_id,
            PersonAnalysisRun.person_id == person_id,
            PersonAnalysisRun.period_start == period_start,
            PersonAnalysisRun.period_end == period_end,
        )
    ).scalar_one_or_none()
    if run and run.evidence_hash == evidence_hash and run.state == LongitudinalState.DONE:
        return run, False
    if run is None:
        run = PersonAnalysisRun(
            org_id=org_id,
            person_id=person_id,
            period_start=period_start,
            period_end=period_end,
            evidence_hash=evidence_hash,
        )
        db.add(run)
        db.flush()
    else:
        run.evidence_hash = evidence_hash
        db.query(LongitudinalFinding).filter(
            LongitudinalFinding.analysis_run_id == run.id
        ).delete(synchronize_session=False)
    _advance(db, run, LongitudinalState.ASSEMBLING)
    run.summary = ""
    run.error = None
    run.prompt_versions = PROMPT_VERSIONS
    return run, True


def _add_finding(
    db: Session,
    run: PersonAnalysisRun,
    kind: FindingKind,
    statement: str,
    evidence_ids: list[str],
    confidence: Confidence,
    prompt_version: str,
    *,
    metadata: dict | None = None,
) -> LongitudinalFinding | None:
    if not statement or not validate_grounding(db, run.org_id, evidence_ids):
        log.warning("longitudinal.grounding_rejected", run=run.id, evidence_ids=evidence_ids)
        return None
    finding = LongitudinalFinding(
        org_id=run.org_id,
        person_id=run.person_id,
        analysis_run_id=run.id,
        kind=kind,
        statement=statement,
        confidence=confidence,
        evidence_item_ids=evidence_ids,
        sample_size=len(evidence_ids),
        finding_metadata=metadata or {},
        prompt_version=prompt_version,
    )
    db.add(finding)
    db.flush()
    return finding


def _already_proposed_for_run(
    db: Session, org_id: str, run_id: str, automation: str
) -> bool:
    rows = db.execute(
        select(ProposedAction).where(ProposedAction.org_id == org_id)
    ).scalars().all()
    return any(
        row.payload.get("analysis_run_id") == run_id
        and row.payload.get("automation") == automation
        for row in rows
    )


def propose_longitudinal_actions(
    db: Session, run: PersonAnalysisRun, findings: list[LongitudinalFinding]
) -> list[str]:
    """Create four approval-gated drafts; never sends or executes anything."""

    evidence_ids = sorted({item_id for finding in findings for item_id in finding.evidence_item_ids})
    if not evidence_ids:
        return []
    from app.db.models import KnowledgeItem

    source = db.get(KnowledgeItem, evidence_ids[-1])
    if source is None:
        return []
    templates = [
        ("pre_meeting_brief", ActionKind.EMAIL_DRAFT, "Pre-meeting participant brief"),
        ("agenda_proposal", ActionKind.CALENDAR_FOLLOWUP, "Agenda proposal for unresolved items"),
        ("stale_commitment_nudge", ActionKind.REMINDER, "Stale commitment nudge"),
        ("weekly_digest", ActionKind.CHANNEL_RECAP, "Weekly participant digest"),
    ]
    body = "\n".join(f"- {finding.statement}" for finding in findings)
    created: list[str] = []
    for automation, kind, title in templates:
        if _already_proposed_for_run(db, run.org_id, run.id, automation):
            continue
        action = ProposedAction(
            org_id=run.org_id,
            capture_session_id=source.capture_session_id,
            kind=kind.value,
            payload={
                "title": title,
                "body": body,
                "target": {"person_id": run.person_id},
                "evidence_item_ids": evidence_ids,
                "analysis_run_id": run.id,
                "automation": automation,
            },
            status=ActionStatus.PENDING_APPROVAL,
        )
        db.add(action)
        db.flush()
        created.append(action.id)
    return created


async def run_person_analysis(
    db: Session,
    org_id: str,
    person_id: str,
    period_start: datetime,
    period_end: datetime,
    llm: LlmClient,
    *,
    ensemble_size: int = 1,
) -> PersonAnalysisRun:
    """Run the fixed FSM. Agents interpret; this function alone advances stages."""

    person = db.get(Person, person_id)
    if person is None or person.org_id != org_id:
        raise ValueError("person not found in org")
    corpus = assemble_person_evidence(db, org_id, person_id, period_start, period_end)
    run, should_process = _upsert_run(
        db, org_id, person_id, period_start, period_end, corpus.evidence_hash
    )
    if not should_process:
        return run
    run.last_evidence_at = corpus.last_evidence_at
    run.coverage_disclosure = corpus.coverage_disclosure
    settings = get_settings()
    try:
        _advance(db, run, LongitudinalState.DETECTING)
        decisions = [item for item in corpus.items if item.type == KnowledgeType.DECISION]
        if decisions:
            result, _usage = await analyze_decision_trajectory(
                llm,
                DecisionTrajectoryInput(person_id=person_id, decisions=decisions),
                model=settings.model_memory,
                ensemble_size=ensemble_size,
            )
            if result and result.status != "insufficient_evidence":
                _add_finding(
                    db, run, FindingKind.DECISION_TRAJECTORY, result.statement,
                    result.evidence_item_ids, result.confidence, DECISION_PROMPT_VERSION,
                    metadata={"status": result.status},
                )
        for candidate in detect_repetition_candidates(db, org_id, person_id, corpus):
            candidate_id = hashlib.sha256(
                "|".join(item.id for item in candidate).encode("utf-8")
            ).hexdigest()[:16]
            result, _usage = await analyze_pattern(
                llm,
                RepetitionCandidateInput(candidate_id=candidate_id, items=candidate),
                model=settings.model_memory,
                ensemble_size=ensemble_size,
            )
            if result and result.candidate_id == candidate_id and result.verdict == "stagnation":
                allowed = {item.id for item in candidate}
                if set(result.evidence_item_ids) <= allowed:
                    _add_finding(
                        db, run, FindingKind.REPETITION, result.statement,
                        result.evidence_item_ids, result.confidence, PATTERN_PROMPT_VERSION,
                        metadata={"candidate_id": candidate_id},
                    )

        _advance(db, run, LongitudinalState.ASSESSING)
        progress, _usage = await assess_progress(
            llm,
            build_progress_input(person_id, corpus),
            model=settings.model_memory,
            ensemble_size=ensemble_size,
        )
        if progress and progress.sufficient_data:
            _add_finding(
                db, run, FindingKind.PROGRESS, progress.statement,
                progress.evidence_item_ids, progress.confidence, PROGRESS_PROMPT_VERSION,
            )

        _advance(db, run, LongitudinalState.AUDITING)
        evidence_by_id = {item.id: item for item in corpus.items}
        findings = db.execute(
            select(LongitudinalFinding).where(LongitudinalFinding.analysis_run_id == run.id)
        ).scalars().all()
        for finding in findings:
            evidence = [evidence_by_id[item_id] for item_id in finding.evidence_item_ids if item_id in evidence_by_id]
            if len(evidence) != len(finding.evidence_item_ids):
                finding.audit_status = FindingAuditStatus.UNSUPPORTED
                finding.audit_rationale = "Grounding invariant failed before audit."
                continue
            audit = await audit_claim(
                llm,
                ClaimAuditInput(
                    claim=AuditableClaim(
                        claim_id=finding.id,
                        statement=finding.statement,
                        evidence_item_ids=finding.evidence_item_ids,
                        confidence=finding.confidence,
                    ),
                    evidence=evidence,
                ),
                model=settings.model_verify,
            )
            if set(audit.supported_item_ids) - set(finding.evidence_item_ids):
                finding.audit_status = FindingAuditStatus.UNSUPPORTED
                finding.audit_rationale = "Auditor cited evidence outside the supplied claim."
            else:
                finding.audit_status = audit.status
                finding.audit_rationale = audit.rationale

        visible = [
            finding for finding in findings
            if finding.audit_status in {
                FindingAuditStatus.SUPPORTED,
                FindingAuditStatus.PARTIALLY_SUPPORTED,
            }
        ]
        _advance(db, run, LongitudinalState.NARRATING)
        if visible:
            narrative = await narrate_participant(
                llm,
                ParticipantNarratorInput(
                    person_id=person_id,
                    display_name=person.display_name,
                    audited_findings=[
                        AuditableClaim(
                            claim_id=finding.id,
                            statement=finding.statement,
                            evidence_item_ids=finding.evidence_item_ids,
                            confidence=finding.confidence,
                        )
                        for finding in visible
                    ],
                    coverage_disclosure=corpus.coverage_disclosure,
                ),
                model=settings.model_report,
            )
            run.summary = narrative.summary
        else:
            run.summary = "No audited longitudinal finding is available for this period."

        _advance(db, run, LongitudinalState.RECOMMENDING)
        propose_longitudinal_actions(db, run, visible)
        _advance(db, run, LongitudinalState.DONE)
        db.flush()
        return run
    except Exception as exc:
        _advance(db, run, LongitudinalState.FAILED)
        run.error = f"{exc}\n{traceback.format_exc(limit=5)}"
        db.flush()
        log.exception("longitudinal.failed", run=run.id, person=person_id)
        return run
