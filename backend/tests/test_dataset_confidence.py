"""Deterministic confidence detector tests (Phase 6).

Covers the pure functions in ``app/datasets/build/confidence.py``: Benford
applicability gating, chi-squared distances, constant/progression fingerprints,
aggregation, and the deterministic CSV report writer.
"""

from __future__ import annotations

import csv
import math
import random

from app.datasets.build.confidence import (
    ConfidenceThresholds,
    aggregate_confidence_metrics,
    benford_distance,
    detect_arithmetic_progression,
    detect_constant_column,
    is_benford_applicable,
    last_digit_chi2,
    write_confidence_report,
)

# --- is_benford_applicable --------------------------------------------------


def test_benford_applicable_natural_like_data() -> None:
    rng = random.Random(20260807)
    # Log-uniform samples span many orders of magnitude and follow Benford.
    values = [10 ** rng.uniform(0.0, 6.0) for _ in range(200)]
    assert is_benford_applicable(values) is True


def test_benford_not_applicable_too_few_samples() -> None:
    values = [10 ** i for i in range(5)]  # only 5 samples
    assert is_benford_applicable(values) is False


def test_benford_not_applicable_single_order_span() -> None:
    values = [1.0 + 0.1 * i for i in range(50)]  # spans < 2 orders
    assert is_benford_applicable(values) is False


def test_benford_not_applicable_negative_values() -> None:
    values = [-10 ** i for i in range(1, 6)] + [10 ** i for i in range(1, 6)]
    assert is_benford_applicable(values) is False


def test_benford_not_applicable_normalized() -> None:
    rng = random.Random(7)
    values = [rng.random() for _ in range(100)]  # [0, 1], normalized
    assert is_benford_applicable(values) is False


def test_benford_not_applicable_non_numeric() -> None:
    values = ["n/a", "?", ""] * 20
    assert is_benford_applicable(values) is False


# --- benford_distance -------------------------------------------------------


def test_benford_distance_uniform_first_digit_flagged() -> None:
    # Every leading digit 1..9 equally represented is far from Benford.
    values = [d * 10 ** 5 for d in range(1, 10)] * 40
    distance = benford_distance(values)
    assert distance > 15.51  # df=8 alpha=0.05 critical value


def test_benford_distance_benford_like_small() -> None:
    rng = random.Random(42)
    values = [10 ** rng.uniform(0.0, 5.0) for _ in range(2000)]
    distance = benford_distance(values)
    assert 0.0 <= distance < 15.51


def test_benford_distance_empty() -> None:
    assert benford_distance([]) == 0.0
    assert benford_distance(["a", "b"]) == 0.0


# --- last_digit_chi2 --------------------------------------------------------


def test_last_digit_chi2_uniform_small() -> None:
    values = [float(d) / 10 for d in range(10)] * 20  # last digits 0..9 uniform
    assert last_digit_chi2(values) < 16.92  # df=9 alpha=0.05 critical value


def test_last_digit_chi2_zeros_and_fives_flagged() -> None:
    values = [5.0, 10.0, 15.0, 20.0, 25.0, 30.0] * 20  # all 0/5 endings
    assert last_digit_chi2(values) > 16.92


def test_last_digit_chi2_exponent_expansion() -> None:
    # 1.5e7 expands to 15000000 -> last digit 0 (not "5" from the mantissa).
    values = [1.5e7] * 30
    assert last_digit_chi2(values) > 16.92


def test_last_digit_chi2_empty() -> None:
    assert last_digit_chi2([]) == 0.0


# --- detect_constant_column -------------------------------------------------


def test_constant_column_true() -> None:
    assert detect_constant_column([3.7] * 40) is True


def test_constant_column_false_when_varying() -> None:
    assert detect_constant_column([1.0, 2.0, 3.0]) is False


def test_constant_column_single_value() -> None:
    assert detect_constant_column([3.7]) is False


# --- detect_arithmetic_progression ------------------------------------------


def test_arithmetic_progression_true() -> None:
    assert detect_arithmetic_progression([1.0, 2.0, 3.0, 4.0, 5.0]) is True
    assert detect_arithmetic_progression([10.0, 20.0, 30.0]) is True


def test_arithmetic_progression_false_irregular() -> None:
    assert detect_arithmetic_progression([1.0, 2.0, 4.0, 8.0]) is False


def test_arithmetic_progression_too_few_distinct() -> None:
    assert detect_arithmetic_progression([5.0, 5.0]) is False


def test_arithmetic_progression_skipped_on_wide_domain() -> None:
    thresholds = ConfidenceThresholds(progression_max_distinct=10)
    values = list(range(100))  # 100 distinct values > max 10 -> skipped
    assert detect_arithmetic_progression(values, thresholds=thresholds) is False


# --- aggregation + report ---------------------------------------------------


def test_aggregate_metrics_constant_and_uniform_columns() -> None:
    summary = aggregate_confidence_metrics(
        {"expression_value": [3.7] * 60, "sample_idx": [1, 2, 3, 4, 5]}
    )
    # 60 identical values: constant flagged; sample_idx is a progression.
    assert summary.anomaly_count >= 2
    by_detector = {
        (f.column, f.detector): f for f in summary.findings
    }
    assert by_detector[("expression_value", "constant_column")].anomaly is True
    assert by_detector[("sample_idx", "arithmetic_progression")].anomaly is True
    # Benford not applicable to a 1..5 span.
    assert by_detector[("sample_idx", "benford_distance")].applicable is False


def test_aggregate_metrics_benford_applicable_flag() -> None:
    rng = random.Random(11)
    values = [10 ** rng.uniform(0.0, 5.0) for _ in range(300)]
    summary = aggregate_confidence_metrics({"value": values})
    findings = {f.detector: f for f in summary.findings}
    assert findings["benford_distance"].applicable is True
    assert math.isfinite(findings["benford_distance"].statistic or math.nan)


def test_aggregate_metrics_empty_columns() -> None:
    summary = aggregate_confidence_metrics({"empty": ["", "n/a"]})
    assert summary.anomaly_count == 0
    assert summary.findings[0].detector == "no_numeric_values"
    assert summary.findings[0].applicable is False


def test_write_confidence_report_deterministic(tmp_path) -> None:
    summary = aggregate_confidence_metrics({"value": [1.0, 2.0, 3.0]})
    path = tmp_path / "confidence_report.csv"
    write_confidence_report(summary, path)
    with path.open("r", encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    assert rows[0]["column"] == "value"
    assert rows[0]["detector"] == "benford_distance"
    assert rows[0]["applicable"] == "false"
    assert rows[0]["statistic"] == ""
    # Deterministic: writing twice yields identical bytes.
    path2 = tmp_path / "confidence_report2.csv"
    write_confidence_report(summary, path2)
    assert path.read_bytes() == path2.read_bytes()
