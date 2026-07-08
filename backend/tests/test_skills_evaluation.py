"""Test 5: SkillEvaluator — coverage, completeness, conflict scoring.

Verifies:
- completeness_score < 1.0 when expected outputs are missing
- conflict_score < 1.0 when duplicate record_ids exist
- perfect evaluation returns overall_score = 1.0
"""

from app.skills import SkillEvaluator, EvaluationReport
from app.skills.manifest import SkillManifest, SkillInputField


def test_completeness_score_partial():
    """When expected outputs are missing from result, completeness < 1.0."""
    report = SkillEvaluator.evaluate(
        skill_id="test",
        result={"field1": 1},
        expected_outputs=["field1", "field2"],
    )
    assert isinstance(report, EvaluationReport)
    assert report.skill_id == "test"
    assert report.completeness_score < 1.0, (
        f"Expected completeness < 1.0, got {report.completeness_score}"
    )
    assert report.completeness_score == 0.5, (
        f"Expected 0.5 (1/2 fields), got {report.completeness_score}"
    )
    assert "field2" in report.missing_outputs


def test_perfect_evaluation():
    """Full coverage, full completeness, no conflicts → overall_score = 1.0."""
    manifest = SkillManifest(
        skill_id="perfect_test",
        name="Perfect Test",
        description="Test manifest for perfect evaluation",
        category="test",
        version="active",
        inputs=[SkillInputField(
            name="data", type="dict", required=True,
            default=None, description="Test input field",
        )],
    )
    report = SkillEvaluator.evaluate(
        skill_id="perfect_test",
        result={"records": [], "total": 0},
        expected_outputs=["records", "total"],
        provided_inputs={"data": {}},
        manifest=manifest,
    )
    assert report.coverage_score == 1.0
    assert report.completeness_score == 1.0
    assert report.conflict_score == 1.0
    assert report.overall_score == 1.0


def test_conflict_score_with_duplicates():
    """Duplicate record_ids should reduce conflict_score below 1.0."""
    duplicate_records = [
        {"record_id": "REC-001", "value": "A"},
        {"record_id": "REC-002", "value": "B"},
        {"record_id": "REC-001", "value": "C"},  # duplicate
        {"record_id": "REC-003", "value": "D"},
    ]
    report = SkillEvaluator.evaluate(
        skill_id="conflict_test",
        result=duplicate_records,
        expected_outputs=[],
    )
    assert report.conflict_score < 1.0, (
        f"Expected conflict_score < 1.0, got {report.conflict_score}"
    )
    # 3 unique out of 4 = 0.75
    assert report.conflict_score == 0.75, (
        f"Expected 0.75, got {report.conflict_score}"
    )
    assert len(report.conflicts) > 0, "Should detect conflicts"
    assert any("REC-001" in c for c in report.conflicts)


def test_no_conflicts_with_unique_ids():
    """All unique record_ids → conflict_score = 1.0."""
    unique_records = [
        {"record_id": "REC-001"},
        {"record_id": "REC-002"},
        {"record_id": "REC-003"},
    ]
    report = SkillEvaluator.evaluate(
        skill_id="unique_test",
        result=unique_records,
    )
    assert report.conflict_score == 1.0
    assert len(report.conflicts) == 0


def test_evaluate_with_skillresult_object():
    """Evaluation should handle SkillResult objects via .data attribute."""
    from app.skills import SkillResult
    sr = SkillResult(True, data={"records": [1, 2, 3], "count": 3})
    report = SkillEvaluator.evaluate(
        skill_id="sr_test",
        result=sr,
        expected_outputs=["records", "count"],
    )
    assert report.completeness_score == 1.0


def test_evaluate_without_manifest():
    """Without manifest, coverage_score is 1.0 (no input constraints)."""
    report = SkillEvaluator.evaluate(
        skill_id="no_manifest_test",
        result={"data": [1, 2]},
        expected_outputs=[],
    )
    assert report.coverage_score == 1.0


def test_overall_score_computation():
    """overall_score = 0.3 * coverage + 0.3 * completeness + 0.4 * conflict."""
    report = SkillEvaluator.evaluate(
        skill_id="score_test",
        result={"a": 1, "b": 2},
        expected_outputs=["a", "b", "c"],  # miss 'c' → completeness = 2/3 ≈ 0.6667
    )
    expected_overall = round(
        0.3 * 1.0 + 0.3 * round(2.0 / 3.0, 4) + 0.4 * 1.0,
        4,
    )
    assert report.overall_score == expected_overall, (
        f"Expected {expected_overall}, got {report.overall_score}"
    )
