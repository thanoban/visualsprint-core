from app.db.models import Confidence, KnowledgeType
from app.evaluation.agent_eval import (
    AgentGoldSample,
    AgentPredictionSample,
    AgentRegressionTolerances,
    LabelledItem,
    compare_to_baseline,
    evaluate,
    main,
)


def _item(
    statement: str,
    *,
    item_type: KnowledgeType = KnowledgeType.COMMITMENT,
    owner: str | None = "nimal",
    confidence: Confidence = Confidence.VERIFIED,
) -> LabelledItem:
    return LabelledItem(
        type=item_type, statement=statement, owner_ref=owner, confidence=confidence
    )


def test_reports_language_slices_and_high_cost_error_rates():
    gold = [
        AgentGoldSample(
            id="en-1",
            language="en",
            source_kind="real_consented",
            items=[_item("Nimal will fix the gateway")],
            pattern_label="progress",
        ),
        AgentGoldSample(
            id="si-1",
            language="si",
            source_kind="real_consented",
            items=[_item("Nimal will deploy the release", owner="nimal")],
            pattern_label="blocked",
        ),
        AgentGoldSample(
            id="ta-1", language="ta", source_kind="real_consented", items=[]
        ),
        AgentGoldSample(
            id="cs-1", language="code_switch", source_kind="synthetic", items=[]
        ),
    ]
    predictions = [
        AgentPredictionSample(
            id="en-1",
            items=[_item("Nimal will fix gateway", owner="nimal")],
            pattern_label="progress",
        ),
        AgentPredictionSample(
            id="si-1",
            items=[_item("Nimal will deploy the release", owner="kamal")],
            pattern_label="stagnation",
        ),
        AgentPredictionSample(id="ta-1", abstained=True),
        AgentPredictionSample(id="cs-1", abstained=True),
    ]

    report = evaluate(gold, predictions, prompt_versions={"context": "context-v1"})

    assert report.real_meeting_samples == 3
    assert set(report.by_language) == {"en", "si", "ta", "code_switch"}
    assert set(report.by_agent) == {"context"}
    assert report.aggregate.extraction_f1 == 1.0
    assert report.aggregate.ownership_accuracy == 0.5
    assert report.aggregate.false_attribution_rate == 0.5
    assert report.aggregate.false_repetition_rate == 0.5
    assert report.aggregate.abstention_rate == 0.5
    assert report.prompt_versions == {"context": "context-v1"}


def test_regression_gate_checks_each_language_not_only_aggregate():
    gold = [
        AgentGoldSample(
            id="en", language="en", source_kind="real_consented", items=[_item("Fix API")]
        ),
        AgentGoldSample(
            id="si", language="si", source_kind="real_consented", items=[_item("Deploy API")]
        ),
    ]
    baseline = evaluate(
        gold,
        [
            AgentPredictionSample(id="en", items=[_item("Fix API")]),
            AgentPredictionSample(id="si", items=[_item("Deploy API")]),
        ],
    )
    current = evaluate(gold, [AgentPredictionSample(id="en", items=[_item("Fix API")])])

    violations = compare_to_baseline(current, baseline, AgentRegressionTolerances())

    assert any(message.startswith("language:si: extraction F1 dropped") for message in violations)


def test_cli_can_require_real_meeting_provenance(tmp_path):
    gold = tmp_path / "gold.jsonl"
    predictions = tmp_path / "predictions.jsonl"
    gold.write_text(
        AgentGoldSample(id="x", language="en", source_kind="synthetic").model_dump_json()
        + "\n",
        encoding="utf-8",
    )
    predictions.write_text(
        AgentPredictionSample(id="x", abstained=True).model_dump_json() + "\n",
        encoding="utf-8",
    )

    assert main(["--gold", str(gold), "--predictions", str(predictions)]) == 0
    assert (
        main(
            [
                "--gold",
                str(gold),
                "--predictions",
                str(predictions),
                "--require-real",
            ]
        )
        == 2
    )
