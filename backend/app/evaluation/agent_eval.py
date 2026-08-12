"""Offline, deterministic evaluation for agent outputs.

The evaluator never calls an LLM. Human-labelled gold JSONL and model prediction
JSONL are produced separately, which keeps CI credential-free and makes prompt/model
regressions reproducible. Language cohorts are always reported separately so an
aggregate cannot hide Sinhala, Tamil, or code-switching failures.
"""

from __future__ import annotations

import argparse
import sys
import unicodedata
from collections import defaultdict
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.db.models import Confidence, KnowledgeType

LanguageCohort = Literal["en", "si", "ta", "code_switch"]
SourceKind = Literal["real_consented", "synthetic"]
PatternLabel = Literal["stagnation", "progress", "blocked", "abstain"]
AgentName = Literal[
    "context",
    "verification",
    "memory",
    "action",
    "report",
    "decision_trajectory",
    "pattern",
    "progress",
    "claim_auditor",
    "participant_narrator",
]


class LabelledItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: KnowledgeType
    statement: str
    owner_ref: str | None = None
    evidence_ids: list[str] = Field(default_factory=list)
    confidence: Confidence = Confidence.VERIFIED


class AgentGoldSample(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    agent: AgentName = "context"
    language: LanguageCohort
    source_kind: SourceKind
    items: list[LabelledItem] = Field(default_factory=list)
    pattern_label: PatternLabel | None = None
    classification: str | None = None


class AgentPredictionSample(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    items: list[LabelledItem] = Field(default_factory=list)
    pattern_label: PatternLabel | None = None
    classification: str | None = None
    abstained: bool = False


class MetricSlice(BaseModel):
    samples: int
    gold_items: int
    predicted_items: int
    matched_items: int
    extraction_precision: float | None
    extraction_recall: float | None
    extraction_f1: float | None
    ownership_accuracy: float | None
    false_attribution_rate: float | None
    verification_accuracy: float | None
    pattern_accuracy: float | None
    classification_accuracy: float | None
    false_repetition_rate: float | None
    abstention_rate: float
    extraction_by_type: dict[str, dict[str, float | int | None]]
    confidence_calibration: dict[str, dict[str, float | int | None]]


class AgentEvaluationReport(BaseModel):
    schema_version: int = 1
    prompt_versions: dict[str, str] = Field(default_factory=dict)
    real_meeting_samples: int
    synthetic_samples: int
    aggregate: MetricSlice
    by_language: dict[str, MetricSlice]
    by_agent: dict[str, MetricSlice]
    missing_prediction_ids: list[str]
    extra_prediction_ids: list[str]


class AgentRegressionTolerances(BaseModel):
    max_f1_drop: float = Field(default=0.0, ge=0.0)
    max_ownership_accuracy_drop: float = Field(default=0.0, ge=0.0)
    max_false_attribution_increase: float = Field(default=0.0, ge=0.0)
    max_verification_accuracy_drop: float = Field(default=0.0, ge=0.0)
    max_pattern_accuracy_drop: float = Field(default=0.0, ge=0.0)
    max_false_repetition_increase: float = Field(default=0.0, ge=0.0)


def _tokens(text: str) -> set[str]:
    normalized = unicodedata.normalize("NFKC", text).casefold()
    cleaned = "".join(
        char if unicodedata.category(char)[0] in {"L", "M", "N"} else " "
        for char in normalized
    )
    return set(cleaned.split())


def _similarity(left: str, right: str) -> float:
    a, b = _tokens(left), _tokens(right)
    if not a and not b:
        return 1.0
    return len(a & b) / len(a | b) if a | b else 0.0


def _match_items(
    gold: Sequence[LabelledItem], predictions: Sequence[LabelledItem], threshold: float = 0.60
) -> list[tuple[LabelledItem, LabelledItem]]:
    candidates: list[tuple[float, int, int]] = []
    for gold_index, expected in enumerate(gold):
        for predicted_index, predicted in enumerate(predictions):
            if expected.type != predicted.type:
                continue
            score = _similarity(expected.statement, predicted.statement)
            if score >= threshold:
                candidates.append((score, gold_index, predicted_index))
    matched_gold: set[int] = set()
    matched_predictions: set[int] = set()
    matches: list[tuple[LabelledItem, LabelledItem]] = []
    for _score, gold_index, predicted_index in sorted(candidates, reverse=True):
        if gold_index in matched_gold or predicted_index in matched_predictions:
            continue
        matched_gold.add(gold_index)
        matched_predictions.add(predicted_index)
        matches.append((gold[gold_index], predictions[predicted_index]))
    return matches


def _ratio(numerator: int, denominator: int) -> float | None:
    return numerator / denominator if denominator else None


def _f1(precision: float | None, recall: float | None) -> float | None:
    if precision is None or recall is None:
        return None
    return 0.0 if precision + recall == 0 else 2 * precision * recall / (precision + recall)


def _slice(
    gold: Sequence[AgentGoldSample], predictions: dict[str, AgentPredictionSample]
) -> MetricSlice:
    gold_total = predicted_total = matched_total = 0
    owner_expected = owner_correct = false_attributions = 0
    verification_total = verification_correct = 0
    pattern_total = pattern_correct = false_repetitions = non_stagnation_patterns = 0
    classification_total = classification_correct = 0
    abstentions = 0
    type_counts: dict[KnowledgeType, list[int]] = defaultdict(lambda: [0, 0, 0])
    calibration: dict[Confidence, list[int]] = defaultdict(lambda: [0, 0])

    for sample in gold:
        prediction = predictions.get(sample.id, AgentPredictionSample(id=sample.id, abstained=True))
        abstentions += int(prediction.abstained)
        matches = _match_items(sample.items, prediction.items)
        gold_total += len(sample.items)
        predicted_total += len(prediction.items)
        matched_total += len(matches)
        for item in sample.items:
            type_counts[item.type][0] += 1
        for item in prediction.items:
            type_counts[item.type][1] += 1
        for expected, predicted in matches:
            type_counts[expected.type][2] += 1
            if expected.owner_ref is not None:
                owner_expected += 1
                owner_correct += int(expected.owner_ref == predicted.owner_ref)
                false_attributions += int(
                    predicted.owner_ref is not None and expected.owner_ref != predicted.owner_ref
                )
            elif predicted.owner_ref is not None:
                false_attributions += 1
                owner_expected += 1
            verification_total += 1
            verification_correct += int(expected.confidence == predicted.confidence)
            bucket = predicted.confidence
            calibration[bucket][0] += 1
            calibration[bucket][1] += int(expected.confidence == predicted.confidence)
        if sample.pattern_label is not None:
            pattern_total += 1
            pattern_correct += int(sample.pattern_label == prediction.pattern_label)
            if sample.pattern_label != "stagnation":
                non_stagnation_patterns += 1
                false_repetitions += int(prediction.pattern_label == "stagnation")
        if sample.classification is not None:
            classification_total += 1
            classification_correct += int(sample.classification == prediction.classification)

    precision = _ratio(matched_total, predicted_total)
    recall = _ratio(matched_total, gold_total)
    by_type: dict[str, dict[str, float | int | None]] = {}
    for knowledge_type in KnowledgeType:
        expected, predicted, matched = type_counts[knowledge_type]
        type_precision = _ratio(matched, predicted)
        type_recall = _ratio(matched, expected)
        by_type[knowledge_type.value] = {
            "gold": expected,
            "predicted": predicted,
            "matched": matched,
            "precision": type_precision,
            "recall": type_recall,
            "f1": _f1(type_precision, type_recall),
        }
    return MetricSlice(
        samples=len(gold),
        gold_items=gold_total,
        predicted_items=predicted_total,
        matched_items=matched_total,
        extraction_precision=precision,
        extraction_recall=recall,
        extraction_f1=_f1(precision, recall),
        ownership_accuracy=_ratio(owner_correct, owner_expected),
        false_attribution_rate=_ratio(false_attributions, owner_expected),
        verification_accuracy=_ratio(verification_correct, verification_total),
        pattern_accuracy=_ratio(pattern_correct, pattern_total),
        classification_accuracy=_ratio(classification_correct, classification_total),
        false_repetition_rate=_ratio(false_repetitions, non_stagnation_patterns),
        abstention_rate=abstentions / len(gold) if gold else 0.0,
        extraction_by_type=by_type,
        confidence_calibration={
            confidence.value: {
                "predictions": counts[0],
                "correct": counts[1],
                "observed_accuracy": _ratio(counts[1], counts[0]),
            }
            for confidence, counts in calibration.items()
        },
    )


def evaluate(
    gold: Sequence[AgentGoldSample],
    prediction_rows: Sequence[AgentPredictionSample],
    *,
    prompt_versions: dict[str, str] | None = None,
) -> AgentEvaluationReport:
    if not gold:
        raise ValueError("gold set is empty")
    gold_by_id = _unique(gold, "gold")
    predictions = _unique(prediction_rows, "predictions")
    cohorts = ("en", "si", "ta", "code_switch")
    return AgentEvaluationReport(
        prompt_versions=prompt_versions or {},
        real_meeting_samples=sum(row.source_kind == "real_consented" for row in gold),
        synthetic_samples=sum(row.source_kind == "synthetic" for row in gold),
        aggregate=_slice(gold, predictions),
        by_language={
            cohort: _slice([row for row in gold if row.language == cohort], predictions)
            for cohort in cohorts
        },
        by_agent={
            agent: _slice([row for row in gold if row.agent == agent], predictions)
            for agent in sorted({row.agent for row in gold})
        },
        missing_prediction_ids=sorted(set(gold_by_id) - set(predictions)),
        extra_prediction_ids=sorted(set(predictions) - set(gold_by_id)),
    )


def compare_to_baseline(
    current: AgentEvaluationReport,
    baseline: AgentEvaluationReport,
    tolerances: AgentRegressionTolerances | None = None,
) -> list[str]:
    tolerances = tolerances or AgentRegressionTolerances()
    violations: list[str] = []
    slices = {
        "aggregate": current.aggregate,
        **{f"language:{key}": value for key, value in current.by_language.items()},
        **{f"agent:{key}": value for key, value in current.by_agent.items()},
    }
    baseline_slices = {
        "aggregate": baseline.aggregate,
        **{f"language:{key}": value for key, value in baseline.by_language.items()},
        **{f"agent:{key}": value for key, value in baseline.by_agent.items()},
    }
    for label, now in slices.items():
        old = baseline_slices.get(label)
        if old is None:
            continue
        _drop(violations, label, "extraction F1", now.extraction_f1, old.extraction_f1, tolerances.max_f1_drop)
        _drop(violations, label, "ownership accuracy", now.ownership_accuracy, old.ownership_accuracy, tolerances.max_ownership_accuracy_drop)
        _increase(violations, label, "false attribution rate", now.false_attribution_rate, old.false_attribution_rate, tolerances.max_false_attribution_increase)
        _drop(violations, label, "verification accuracy", now.verification_accuracy, old.verification_accuracy, tolerances.max_verification_accuracy_drop)
        _drop(violations, label, "pattern accuracy", now.pattern_accuracy, old.pattern_accuracy, tolerances.max_pattern_accuracy_drop)
        _increase(violations, label, "false repetition rate", now.false_repetition_rate, old.false_repetition_rate, tolerances.max_false_repetition_increase)
    return violations


def _drop(out: list[str], cohort: str, name: str, current: float | None, baseline: float | None, tolerance: float) -> None:
    if baseline is not None and (current is None or current < baseline - tolerance):
        out.append(f"{cohort}: {name} dropped from {baseline:.4f} to {current if current is not None else 'not measurable'}")


def _increase(out: list[str], cohort: str, name: str, current: float | None, baseline: float | None, tolerance: float) -> None:
    if baseline is not None and current is not None and current > baseline + tolerance:
        out.append(f"{cohort}: {name} increased from {baseline:.4f} to {current:.4f}")


def _unique[T: BaseModel](rows: Sequence[T], label: str) -> dict[str, T]:
    indexed: dict[str, T] = {}
    for row in rows:
        row_id = str(row.id)  # type: ignore[attr-defined] -- both accepted row models expose id
        if row_id in indexed:
            raise ValueError(f"duplicate id {row_id!r} in {label}")
        indexed[row_id] = row
    return indexed


def _load_jsonl[T: BaseModel](path: Path, model: type[T]) -> list[T]:
    rows: list[T] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            rows.append(model.model_validate_json(line))
        except ValueError as exc:
            raise ValueError(f"{path}:{line_number}: {exc}") from exc
    return rows


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Score frozen agent predictions")
    parser.add_argument("--gold", required=True, type=Path)
    parser.add_argument("--predictions", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--require-real", action="store_true")
    parser.add_argument("--prompt-version", action="append", default=[], metavar="AGENT=VERSION")
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    args = build_parser().parse_args(list(argv) if argv is not None else None)
    versions = dict(value.split("=", 1) for value in args.prompt_version)
    report = evaluate(
        _load_jsonl(args.gold, AgentGoldSample),
        _load_jsonl(args.predictions, AgentPredictionSample),
        prompt_versions=versions,
    )
    rendered = report.model_dump_json(indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    else:
        sys.stdout.write(rendered)
    if args.require_real and report.real_meeting_samples == 0:
        print("REGRESSION: corpus contains no consented real-meeting samples", file=sys.stderr)
        return 2
    if args.baseline:
        baseline = AgentEvaluationReport.model_validate_json(args.baseline.read_text("utf-8"))
        violations = compare_to_baseline(report, baseline)
        for violation in violations:
            print(f"REGRESSION: {violation}", file=sys.stderr)
        if violations:
            return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
