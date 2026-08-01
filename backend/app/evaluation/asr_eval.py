"""Deterministic ASR evaluation and provider ranking.

The harness consumes hand-authored gold JSONL plus one or more provider
hypothesis JSONL files. It intentionally does not call vendors: producing
hypotheses and scoring them are separate steps, so the permanent gold set can
be used in CI without credentials or network access.
"""

from __future__ import annotations

import argparse
import sys
import unicodedata
from collections.abc import Iterable, Sequence
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from app.interfaces.transcriber import Lang


class GoldSample(BaseModel):
    """One consented, hand-transcribed evaluation span.

    ``switch_points`` are token boundaries: ``3`` means the language changes
    after the third normalized reference token. Entity matching is
    case-insensitive and punctuation-insensitive.
    """

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    reference: str
    language_tags: list[Lang] = Field(min_length=1)
    switch_points: list[int] = Field(default_factory=list)
    entities: list[str] = Field(default_factory=list)


class HypothesisSample(BaseModel):
    """A vendor/cascade result aligned to a ``GoldSample.id``."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    text: str
    switch_points: list[int] = Field(default_factory=list)


class AsrMetrics(BaseModel):
    samples: int
    matched_samples: int
    coverage: float
    reference_words: int
    word_errors: int
    wer: float
    code_switch_wer: float | None
    switch_points_reference: int
    switch_points_hypothesis: int
    switch_point_precision: float | None
    switch_point_recall: float | None
    switch_point_f1: float | None
    entities_reference: int
    entities_matched: int
    entity_accuracy: float | None
    wer_by_language: dict[str, float | None]


class ProviderEvaluation(BaseModel):
    provider: str
    rank: int = 0
    metrics: AsrMetrics
    missing_hypothesis_ids: list[str]
    extra_hypothesis_ids: list[str]


class EvaluationReport(BaseModel):
    schema_version: int = 1
    providers: list[ProviderEvaluation]


class RegressionTolerances(BaseModel):
    max_wer_increase: float = Field(default=0.0, ge=0.0)
    max_switch_f1_drop: float = Field(default=0.0, ge=0.0)
    max_entity_accuracy_drop: float = Field(default=0.0, ge=0.0)
    max_coverage_drop: float = Field(default=0.0, ge=0.0)


def normalize_tokens(text: str) -> list[str]:
    """Normalize Unicode text without dropping Sinhala/Tamil combining marks."""

    normalized = unicodedata.normalize("NFKC", text).casefold()
    characters = [
        char if unicodedata.category(char)[0] in {"L", "M", "N"} else " " for char in normalized
    ]
    return "".join(characters).split()


def edit_distance(reference: Sequence[str], hypothesis: Sequence[str]) -> int:
    """Return Levenshtein distance using O(len(hypothesis)) memory."""

    previous = list(range(len(hypothesis) + 1))
    for ref_index, ref_token in enumerate(reference, start=1):
        current = [ref_index]
        for hyp_index, hyp_token in enumerate(hypothesis, start=1):
            substitution = previous[hyp_index - 1] + (ref_token != hyp_token)
            insertion = current[hyp_index - 1] + 1
            deletion = previous[hyp_index] + 1
            current.append(min(substitution, insertion, deletion))
        previous = current
    return previous[-1]


def word_error_rate(reference: str, hypothesis: str) -> float:
    reference_tokens = normalize_tokens(reference)
    hypothesis_tokens = normalize_tokens(hypothesis)
    if not reference_tokens:
        return 0.0 if not hypothesis_tokens else 1.0
    return edit_distance(reference_tokens, hypothesis_tokens) / len(reference_tokens)


def _matched_switch_points(
    reference: Sequence[int], hypothesis: Sequence[int], tolerance: int = 1
) -> int:
    available = list(sorted(hypothesis))
    matched = 0
    for expected in sorted(reference):
        candidates = [
            (abs(actual - expected), index)
            for index, actual in enumerate(available)
            if abs(actual - expected) <= tolerance
        ]
        if not candidates:
            continue
        _, best_index = min(candidates)
        available.pop(best_index)
        matched += 1
    return matched


def _safe_ratio(numerator: int, denominator: int) -> float | None:
    return numerator / denominator if denominator else None


def _f1(precision: float | None, recall: float | None) -> float | None:
    if precision is None or recall is None:
        return None
    if precision + recall == 0:
        return 0.0
    return 2 * precision * recall / (precision + recall)


def _contains_entity(hypothesis_tokens: Sequence[str], entity: str) -> bool:
    entity_tokens = normalize_tokens(entity)
    if not entity_tokens:
        return False
    width = len(entity_tokens)
    return any(
        list(hypothesis_tokens[start : start + width]) == entity_tokens
        for start in range(len(hypothesis_tokens) - width + 1)
    )


def _language_wer(
    language: Lang,
    gold: Sequence[GoldSample],
    hypotheses: dict[str, HypothesisSample],
) -> float | None:
    errors = 0
    words = 0
    for sample in gold:
        if language not in sample.language_tags:
            continue
        reference_tokens = normalize_tokens(sample.reference)
        hypothesis = hypotheses.get(sample.id)
        hypothesis_tokens = normalize_tokens(hypothesis.text) if hypothesis else []
        errors += edit_distance(reference_tokens, hypothesis_tokens)
        words += len(reference_tokens)
    return errors / words if words else None


def evaluate_provider(
    provider: str,
    gold: Sequence[GoldSample],
    hypothesis_rows: Sequence[HypothesisSample],
) -> ProviderEvaluation:
    """Score one provider. Missing hypotheses count as empty transcripts."""

    hypotheses = _unique_by_id(hypothesis_rows, f"hypotheses for {provider}")
    gold_by_id = _unique_by_id(gold, "gold samples")
    missing = sorted(set(gold_by_id) - set(hypotheses))
    extra = sorted(set(hypotheses) - set(gold_by_id))

    total_errors = 0
    total_words = 0
    code_switch_errors = 0
    code_switch_words = 0
    reference_switches = 0
    hypothesis_switches = 0
    matched_switches = 0
    entity_total = 0
    entity_matches = 0

    for sample in gold:
        hypothesis = hypotheses.get(sample.id)
        hypothesis_text = hypothesis.text if hypothesis else ""
        hypothesis_points = hypothesis.switch_points if hypothesis else []
        reference_tokens = normalize_tokens(sample.reference)
        hypothesis_tokens = normalize_tokens(hypothesis_text)
        errors = edit_distance(reference_tokens, hypothesis_tokens)

        total_errors += errors
        total_words += len(reference_tokens)
        if len(set(sample.language_tags) - {Lang.UNKNOWN}) > 1:
            code_switch_errors += errors
            code_switch_words += len(reference_tokens)

        reference_switches += len(sample.switch_points)
        hypothesis_switches += len(hypothesis_points)
        matched_switches += _matched_switch_points(sample.switch_points, hypothesis_points)

        entity_total += len(sample.entities)
        entity_matches += sum(
            _contains_entity(hypothesis_tokens, entity) for entity in sample.entities
        )

    precision = _safe_ratio(matched_switches, hypothesis_switches)
    recall = _safe_ratio(matched_switches, reference_switches)
    if reference_switches == 0 and hypothesis_switches == 0:
        precision = recall = None

    metrics = AsrMetrics(
        samples=len(gold),
        matched_samples=len(gold) - len(missing),
        coverage=(len(gold) - len(missing)) / len(gold) if gold else 1.0,
        reference_words=total_words,
        word_errors=total_errors,
        wer=total_errors / total_words if total_words else 0.0,
        code_switch_wer=code_switch_errors / code_switch_words if code_switch_words else None,
        switch_points_reference=reference_switches,
        switch_points_hypothesis=hypothesis_switches,
        switch_point_precision=precision,
        switch_point_recall=recall,
        switch_point_f1=_f1(precision, recall),
        entities_reference=entity_total,
        entities_matched=entity_matches,
        entity_accuracy=_safe_ratio(entity_matches, entity_total),
        wer_by_language={
            language.value: _language_wer(language, gold, hypotheses)
            for language in (Lang.SI, Lang.TA, Lang.EN)
        },
    )
    return ProviderEvaluation(
        provider=provider,
        metrics=metrics,
        missing_hypothesis_ids=missing,
        extra_hypothesis_ids=extra,
    )


def evaluate_all(
    gold: Sequence[GoldSample],
    providers: dict[str, Sequence[HypothesisSample]],
) -> EvaluationReport:
    if not gold:
        raise ValueError("gold set is empty")
    if not providers:
        raise ValueError("at least one provider hypothesis is required")

    evaluations = [
        evaluate_provider(provider, gold, rows) for provider, rows in sorted(providers.items())
    ]
    evaluations.sort(
        key=lambda result: (
            result.metrics.wer,
            -(
                result.metrics.switch_point_f1
                if result.metrics.switch_point_f1 is not None
                else -1.0
            ),
            -(
                result.metrics.entity_accuracy
                if result.metrics.entity_accuracy is not None
                else -1.0
            ),
            result.provider,
        )
    )
    for rank, result in enumerate(evaluations, start=1):
        result.rank = rank
    return EvaluationReport(providers=evaluations)


def compare_to_baseline(
    current: EvaluationReport,
    baseline: EvaluationReport,
    tolerances: RegressionTolerances | None = None,
) -> list[str]:
    tolerances = tolerances or RegressionTolerances()
    baseline_by_provider = {result.provider: result for result in baseline.providers}
    violations: list[str] = []

    for result in current.providers:
        previous = baseline_by_provider.get(result.provider)
        if previous is None:
            continue
        metrics = result.metrics
        old = previous.metrics
        if metrics.wer > old.wer + tolerances.max_wer_increase:
            violations.append(
                f"{result.provider}: WER increased from {old.wer:.4f} to {metrics.wer:.4f}"
            )
        _check_optional_drop(
            violations,
            result.provider,
            "switch-point F1",
            metrics.switch_point_f1,
            old.switch_point_f1,
            tolerances.max_switch_f1_drop,
        )
        _check_optional_drop(
            violations,
            result.provider,
            "entity accuracy",
            metrics.entity_accuracy,
            old.entity_accuracy,
            tolerances.max_entity_accuracy_drop,
        )
        if metrics.coverage < old.coverage - tolerances.max_coverage_drop:
            violations.append(
                f"{result.provider}: coverage dropped from {old.coverage:.4f} to {metrics.coverage:.4f}"
            )
    return violations


def _check_optional_drop(
    violations: list[str],
    provider: str,
    metric_name: str,
    current: float | None,
    baseline: float | None,
    tolerance: float,
) -> None:
    if baseline is None:
        return
    if current is None or current < baseline - tolerance:
        rendered = "not measurable" if current is None else f"{current:.4f}"
        violations.append(f"{provider}: {metric_name} dropped from {baseline:.4f} to {rendered}")


def _unique_by_id[T: GoldSample | HypothesisSample](rows: Sequence[T], label: str) -> dict[str, T]:
    indexed: dict[str, T] = {}
    for row in rows:
        if row.id in indexed:
            raise ValueError(f"duplicate id {row.id!r} in {label}")
        indexed[row.id] = row
    return indexed


def load_gold(path: Path) -> list[GoldSample]:
    return _load_jsonl(path, GoldSample)


def load_hypotheses(path: Path) -> list[HypothesisSample]:
    return _load_jsonl(path, HypothesisSample)


def _load_jsonl[T: BaseModel](path: Path, model: type[T]) -> list[T]:
    rows: list[T] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            rows.append(model.model_validate_json(line))
        except ValueError as exc:
            raise ValueError(f"{path}:{line_number}: {exc}") from exc
    return rows


def _provider_argument(value: str) -> tuple[str, Path]:
    provider, separator, raw_path = value.partition("=")
    if not separator or not provider.strip() or not raw_path.strip():
        raise argparse.ArgumentTypeError("expected PROVIDER=PATH")
    return provider.strip(), Path(raw_path)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Score and rank ASR provider hypotheses")
    parser.add_argument("--gold", required=True, type=Path, help="Gold JSONL file")
    parser.add_argument(
        "--hypothesis",
        required=True,
        action="append",
        type=_provider_argument,
        metavar="PROVIDER=PATH",
        help="Provider hypothesis JSONL; repeat to rank multiple providers",
    )
    parser.add_argument("--output", type=Path, help="Write report JSON to this path")
    parser.add_argument("--baseline", type=Path, help="Prior report JSON for regression checks")
    parser.add_argument("--max-wer-increase", type=float, default=0.0)
    parser.add_argument("--max-switch-f1-drop", type=float, default=0.0)
    parser.add_argument("--max-entity-accuracy-drop", type=float, default=0.0)
    parser.add_argument("--max-coverage-drop", type=float, default=0.0)
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    args = build_parser().parse_args(list(argv) if argv is not None else None)
    provider_paths: list[tuple[str, Path]] = args.hypothesis
    providers: dict[str, Sequence[HypothesisSample]] = {}
    for provider, path in provider_paths:
        if provider in providers:
            raise ValueError(f"duplicate provider label {provider!r}")
        providers[provider] = load_hypotheses(path)

    report = evaluate_all(load_gold(args.gold), providers)
    rendered = report.model_dump_json(indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    else:
        sys.stdout.write(rendered)

    if not args.baseline:
        return 0
    baseline = EvaluationReport.model_validate_json(args.baseline.read_text(encoding="utf-8"))
    tolerances = RegressionTolerances(
        max_wer_increase=args.max_wer_increase,
        max_switch_f1_drop=args.max_switch_f1_drop,
        max_entity_accuracy_drop=args.max_entity_accuracy_drop,
        max_coverage_drop=args.max_coverage_drop,
    )
    violations = compare_to_baseline(report, baseline, tolerances)
    for violation in violations:
        print(f"REGRESSION: {violation}", file=sys.stderr)
    return 2 if violations else 0


if __name__ == "__main__":
    raise SystemExit(main())
