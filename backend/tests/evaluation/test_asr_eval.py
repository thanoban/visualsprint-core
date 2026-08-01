import json

import pytest

from app.evaluation.asr_eval import (
    EvaluationReport,
    GoldSample,
    HypothesisSample,
    RegressionTolerances,
    compare_to_baseline,
    edit_distance,
    evaluate_all,
    main,
    normalize_tokens,
    word_error_rate,
)
from app.interfaces.transcriber import Lang


def _gold(
    sample_id: str,
    reference: str,
    languages: list[Lang],
    *,
    switch_points: list[int] | None = None,
    entities: list[str] | None = None,
) -> GoldSample:
    return GoldSample(
        id=sample_id,
        reference=reference,
        language_tags=languages,
        switch_points=switch_points or [],
        entities=entities or [],
    )


def _hypothesis(
    sample_id: str, text: str, switch_points: list[int] | None = None
) -> HypothesisSample:
    return HypothesisSample(id=sample_id, text=text, switch_points=switch_points or [])


def test_unicode_normalization_preserves_sinhala_and_tamil_words():
    tokens = normalize_tokens("සිංහල, தமிழ்! MongoDB PAY-442")

    assert tokens == ["සිංහල", "தமிழ்", "mongodb", "pay", "442"]


def test_edit_distance_and_word_error_rate_cover_insert_delete_substitute():
    assert edit_distance(["a", "b", "c"], ["a", "x", "c", "d"]) == 2
    assert word_error_rate("one two three", "one too three four") == pytest.approx(2 / 3)


def test_evaluation_penalizes_missing_rows_and_scores_switches_entities_and_languages():
    gold = [
        _gold(
            "cs",
            "api eka deploy Friday",
            [Lang.SI, Lang.EN],
            switch_points=[2],
            entities=["Friday", "API"],
        ),
        _gold("ta", "வணக்கம் team", [Lang.TA, Lang.EN], entities=["team"]),
    ]
    hypotheses = [_hypothesis("cs", "API eka deploy Friday", switch_points=[3])]

    result = evaluate_all(gold, {"google": hypotheses}).providers[0]

    assert result.metrics.samples == 2
    assert result.metrics.matched_samples == 1
    assert result.metrics.coverage == 0.5
    assert result.metrics.wer == pytest.approx(2 / 6)
    assert result.metrics.code_switch_wer == pytest.approx(2 / 6)
    assert result.metrics.switch_point_f1 == 1.0  # one-token tolerance
    assert result.metrics.entity_accuracy == pytest.approx(2 / 3)
    assert result.metrics.wer_by_language["ta"] == 1.0
    assert result.missing_hypothesis_ids == ["ta"]


def test_provider_ranking_uses_wer_before_secondary_metrics():
    gold = [_gold("one", "ship MongoDB today", [Lang.EN], entities=["MongoDB"])]

    report = evaluate_all(
        gold,
        {
            "azure": [_hypothesis("one", "ship database today")],
            "google": [_hypothesis("one", "ship MongoDB today")],
        },
    )

    assert [(row.provider, row.rank) for row in report.providers] == [
        ("google", 1),
        ("azure", 2),
    ]


def test_duplicate_ids_are_rejected():
    sample = _gold("duplicate", "hello", [Lang.EN])

    with pytest.raises(ValueError, match="duplicate id"):
        evaluate_all([sample, sample], {"provider": []})


def test_baseline_comparison_reports_metric_regressions():
    gold = [
        _gold(
            "one",
            "deploy Friday",
            [Lang.SI, Lang.EN],
            switch_points=[1],
            entities=["Friday"],
        )
    ]
    baseline = evaluate_all(
        gold, {"cascade": [_hypothesis("one", "deploy Friday", switch_points=[1])]}
    )
    current = evaluate_all(gold, {"cascade": [_hypothesis("one", "deploy someday")]})

    violations = compare_to_baseline(
        current,
        baseline,
        RegressionTolerances(max_wer_increase=0.1, max_switch_f1_drop=0.1),
    )

    assert any("WER increased" in violation for violation in violations)
    assert any("switch-point F1 dropped" in violation for violation in violations)
    assert any("entity accuracy dropped" in violation for violation in violations)


def test_cli_writes_ranked_report_and_fails_on_regression(tmp_path):
    gold_path = tmp_path / "gold.jsonl"
    hypothesis_path = tmp_path / "hypothesis.jsonl"
    report_path = tmp_path / "report.json"
    baseline_path = tmp_path / "baseline.json"
    gold_path.write_text(
        _gold("one", "hello world", [Lang.EN]).model_dump_json() + "\n",
        encoding="utf-8",
    )
    hypothesis_path.write_text(
        _hypothesis("one", "hello world").model_dump_json() + "\n",
        encoding="utf-8",
    )

    exit_code = main(
        [
            "--gold",
            str(gold_path),
            "--hypothesis",
            f"cascade={hypothesis_path}",
            "--output",
            str(report_path),
        ]
    )
    assert exit_code == 0
    report = EvaluationReport.model_validate_json(report_path.read_text(encoding="utf-8"))
    assert report.providers[0].metrics.wer == 0.0

    baseline_path.write_text(report.model_dump_json(), encoding="utf-8")
    hypothesis_path.write_text(
        _hypothesis("one", "wrong words").model_dump_json() + "\n",
        encoding="utf-8",
    )
    exit_code = main(
        [
            "--gold",
            str(gold_path),
            "--hypothesis",
            f"cascade={hypothesis_path}",
            "--baseline",
            str(baseline_path),
            "--output",
            str(report_path),
        ]
    )
    assert exit_code == 2
    assert (
        json.loads(report_path.read_text(encoding="utf-8"))["providers"][0]["metrics"]["wer"] == 1.0
    )
