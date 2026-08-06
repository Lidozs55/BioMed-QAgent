"""Deterministic statistical confidence detectors (Phase 6).

Pure, side-effect-free detectors that flag "passes validation yet implausible"
numeric columns (SURVEY §4.1). They are a supplementary signal on top of the
validation gate, never a replacement for it: findings are written to
``confidence_report.csv`` and surfaced as warnings, they do not block release
in the v1 policy (SURVEY §7 — warning only until thresholds are calibrated).

All functions are deterministic and streaming-friendly; none of them touch the
contracts module (ValidationResultStatus stays PASSED/FAILED), so this module
does not overlap with the Phase 4 workspace.
"""

from __future__ import annotations

import csv
import math
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

# --- Benford's law expectations ---------------------------------------------

_BENFORD_DIGITS = tuple(range(1, 10))
BENFORD_EXPECTED = {d: math.log10(1.0 + 1.0 / d) for d in _BENFORD_DIGITS}

#: Last-digit uniformity is tested over decimal digits 0-9.
_LAST_DIGITS = tuple(range(10))

#: Relative tolerance used for constant-column and arithmetic-progression
#: comparisons; works across value scales without an absolute epsilon.
_REL_TOL = 1e-6


@dataclass(frozen=True)
class ConfidenceThresholds:
    """Detector thresholds, owned by the validation profile (per design).

    The v1 values follow SURVEY §7: warning-only, never release-blocking;
    the Profile passes these in so they can be tightened after calibration.
    """

    min_benford_samples: int = 30
    benford_min_order_span: int = 2  # max/min >= 10**span (>= 2 orders of magnitude)
    benford_chi2_limit: float = 15.51  # df=8, alpha=0.05
    last_digit_chi2_limit: float = 16.92  # df=9, alpha=0.05
    progression_max_distinct: int = 200  # avoid O(n^2) on wide value domains


@dataclass(frozen=True)
class DetectorFinding:
    """One detector's verdict for one numeric column."""

    column: str
    detector: str
    applicable: bool
    statistic: float | None
    anomaly: bool
    detail: str


@dataclass(frozen=True)
class ConfidenceSummary:
    """Aggregated per-column detector findings (the confidence contract)."""

    findings: tuple[DetectorFinding, ...] = field(default_factory=tuple)
    anomaly_count: int = 0

    @property
    def anomalies(self) -> tuple[DetectorFinding, ...]:
        return tuple(f for f in self.findings if f.anomaly)


# --- numeric helpers --------------------------------------------------------


def _as_floats(values: Sequence[float | int | str]) -> list[float]:
    """Parse to finite floats; non-numeric / non-finite entries are skipped."""
    out: list[float] = []
    for value in values:
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(number):
            out.append(number)
    return out


def _last_decimal_digit(value: float) -> int | None:
    """Last digit of *value*'s decimal representation, exponent-expanded.

    ``1.5e7`` expands to ``15000000.0`` -> last digit 0; ``1.23`` -> 3;
    zeros before the decimal point keep their signal (many 0/5 endings is
    the artifact we want to catch, SURVEY §4.1B).
    """
    if not math.isfinite(value):
        return None
    text = format(abs(value), "f").rstrip("0").rstrip(".")
    if not text or text in ("-", ""):
        return None
    return int(text[-1])


# --- Benford applicability (前置判定) ---------------------------------------


def is_benford_applicable(
    values: Sequence[float | int | str],
    *,
    thresholds: ConfidenceThresholds | None = None,
) -> bool:
    """Whether Benford first-digit detection is meaningful for *values*.

    Returns False when the data is boundary-constrained: negative values,
    zero/invalid entries, a value range spanning fewer than two orders of
    magnitude, normalized [0, 1] data, or too small a sample (SURVEY §4.1A,
    §7). Applying Benford to such data would produce false positives.
    """
    limits = thresholds or ConfidenceThresholds()
    parsed = _as_floats(values)
    if len(parsed) < limits.min_benford_samples:
        return False
    if any(v < 0 for v in parsed):
        return False
    positive = [v for v in parsed if v > 0]
    if not positive:
        return False
    low, high = min(positive), max(parsed)
    if low <= 0 or high / low < 10 ** limits.benford_min_order_span:
        return False
    # normalized / boundary-constrained to [0, 1]
    return high > 1.0


# --- detectors --------------------------------------------------------------


def benford_distance(
    values: Sequence[float | int | str],
    *,
    thresholds: ConfidenceThresholds | None = None,
) -> float:
    """Chi-squared distance of the first-digit distribution from Benford.

    Only meaningful when :func:`is_benford_applicable` holds (callers should
    gate on it); the function itself skips non-positive values, which are
    irrelevant to first digits.
    """
    observed = Counter(
        int(format(abs(v), "e")[0]) for v in _as_floats(values) if v > 0
    )
    total = sum(observed.values())
    if total == 0:
        return 0.0
    chi2 = 0.0
    for digit in _BENFORD_DIGITS:
        expected = total * BENFORD_EXPECTED[digit]
        count = observed.get(digit, 0)
        chi2 += (count - expected) ** 2 / expected
    return chi2


def last_digit_chi2(
    values: Sequence[float | int | str],
    *,
    thresholds: ConfidenceThresholds | None = None,
) -> float:
    """Chi-squared statistic for last-digit uniformity (digits 0-9).

    Fabricated measurements cluster on 0/5 endings; real measurements spread
    uniformly over the last digit (SURVEY §4.1B). Non-finite and digit-less
    values are skipped.
    """
    observed = Counter(
        digit
        for v in _as_floats(values)
        if (digit := _last_decimal_digit(v)) is not None
    )
    total = sum(observed.values())
    if total == 0:
        return 0.0
    chi2 = 0.0
    expected = total / len(_LAST_DIGITS)
    for digit in _LAST_DIGITS:
        count = observed.get(digit, 0)
        chi2 += (count - expected) ** 2 / expected
    return chi2


def detect_constant_column(
    values: Sequence[float | int | str],
    *,
    thresholds: ConfidenceThresholds | None = None,
) -> bool:
    """True when every value equals the first (relative tolerance)."""
    parsed = _as_floats(values)
    if len(parsed) < 2:
        return False
    first = parsed[0]
    return all(abs(v - first) <= _REL_TOL * max(1.0, abs(first)) for v in parsed)


def detect_arithmetic_progression(
    values: Sequence[float | int | str],
    *,
    thresholds: ConfidenceThresholds | None = None,
) -> bool:
    """True when the sorted distinct values form an equal-spaced sequence.

    Equal spacing across a column is a strong manual-fabrication fingerprint
    (SURVEY §4.1C). Only enabled when the number of distinct values is small,
    keeping the sort O(k log k) and avoiding O(n^2) comparisons on wide
    value domains (SURVEY §7).
    """
    limits = thresholds or ConfidenceThresholds()
    parsed = sorted(set(_as_floats(values)))
    if len(parsed) < 3 or len(parsed) > limits.progression_max_distinct:
        return False
    steps = {parsed[i + 1] - parsed[i] for i in range(len(parsed) - 1)}
    if not steps or 0.0 in steps:
        return False
    first_step = next(iter(steps))
    return all(
        abs(step - first_step) <= _REL_TOL * max(1.0, abs(first_step))
        for step in steps
    )


# --- aggregation ------------------------------------------------------------


def aggregate_confidence_metrics(
    columns: Mapping[str, Sequence[float | int | str]],
    *,
    thresholds: ConfidenceThresholds | None = None,
) -> ConfidenceSummary:
    """Run the applicable detectors over every numeric column.

    Each column yields one finding per detector (applicable or not), so the
    report is complete and reproducible; ``anomaly_count`` counts only
    findings flagged as anomalies.
    """
    limits = thresholds or ConfidenceThresholds()
    findings: list[DetectorFinding] = []
    for column, column_values in columns.items():
        parsed = _as_floats(column_values)
        if not parsed:
            findings.append(
                DetectorFinding(
                    column=column,
                    detector="no_numeric_values",
                    applicable=False,
                    statistic=None,
                    anomaly=False,
                    detail="column has no finite numeric values",
                )
            )
            continue

        if is_benford_applicable(column_values, thresholds=limits):
            distance = benford_distance(column_values, thresholds=limits)
            anomaly = distance > limits.benford_chi2_limit
            findings.append(
                DetectorFinding(
                    column=column,
                    detector="benford_distance",
                    applicable=True,
                    statistic=distance,
                    anomaly=anomaly,
                    detail=(
                        f"first-digit chi2={distance:.3f}, "
                        f"limit={limits.benford_chi2_limit}"
                    ),
                )
            )
        else:
            findings.append(
                DetectorFinding(
                    column=column,
                    detector="benford_distance",
                    applicable=False,
                    statistic=None,
                    anomaly=False,
                    detail="is_benford_applicable returned False",
                )
            )

        chi2 = last_digit_chi2(column_values, thresholds=limits)
        anomaly = chi2 > limits.last_digit_chi2_limit
        findings.append(
            DetectorFinding(
                column=column,
                detector="last_digit_chi2",
                applicable=True,
                statistic=chi2,
                anomaly=anomaly,
                detail=(
                    f"last-digit chi2={chi2:.3f}, "
                    f"limit={limits.last_digit_chi2_limit}"
                ),
            )
        )

        constant = detect_constant_column(column_values, thresholds=limits)
        findings.append(
            DetectorFinding(
                column=column,
                detector="constant_column",
                applicable=True,
                statistic=None,
                anomaly=constant,
                detail=(
                    "all values identical within tolerance"
                    if constant
                    else "values vary"
                ),
            )
        )

        progression = detect_arithmetic_progression(column_values, thresholds=limits)
        findings.append(
            DetectorFinding(
                column=column,
                detector="arithmetic_progression",
                applicable=True,
                statistic=None,
                anomaly=progression,
                detail=(
                    "distinct values form an equal-spaced sequence"
                    if progression
                    else "no equal-spaced sequence"
                ),
            )
        )
    anomaly_count = sum(1 for f in findings if f.anomaly)
    return ConfidenceSummary(findings=tuple(findings), anomaly_count=anomaly_count)


# --- report output ----------------------------------------------------------


_REPORT_HEADER = ["column", "detector", "applicable", "statistic", "anomaly", "detail"]


def write_confidence_report(summary: ConfidenceSummary, path: Path) -> None:
    """Deterministically write *summary* findings to a CSV report."""
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(_REPORT_HEADER)
        for finding in summary.findings:
            writer.writerow(
                [
                    finding.column,
                    finding.detector,
                    "true" if finding.applicable else "false",
                    "" if finding.statistic is None else f"{finding.statistic:.6f}",
                    "true" if finding.anomaly else "false",
                    finding.detail,
                ]
            )


def column_values_from_rows(
    rows: Iterable[Mapping[str, str]],
    column: str,
) -> list[str]:
    """Extract a column's raw string values from CSV rows (for testing/report)."""
    return [row.get(column, "") for row in rows]
