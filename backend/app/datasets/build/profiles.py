"""Versioned profiles for the expression demo chain (Phase 3).

Two registries:

- ``NORMALIZATION_PROFILES``: entity/unit normalization policy consumed by the
  Canonicalizer (namespaces, allowed units/semantics, conversions).
- ``VALIDATION_PROFILES``: concrete per-family check implementations driven by
  the contract ``ValidationProfile`` skeleton (acceptance policy included).
  ``gene_expression.release.v1`` implements the expression demo checks.
"""

from __future__ import annotations

import csv
import json
import math
from dataclasses import dataclass
from pathlib import Path

from app.datasets.build.confidence import (
    ConfidenceThresholds,
    aggregate_confidence_metrics,
    write_confidence_report,
)
from app.datasets.contracts import (
    AcceptancePolicy,
    DatasetManifest,
    DatasetSchema,
    NormalizationProfile,
    ValidationProfile,
    ValidationResult,
    ValidationResultStatus,
)

# --- normalization profiles -------------------------------------------------


def _expression_normalization_v1() -> NormalizationProfile:
    return NormalizationProfile(
        profile_id="gene_expression.normalization.v1",
        dataset_family="gene_expression",
        allowed_namespaces=["ensembl_gene", "gene_symbol"],
        allowed_units=[
            "expression_value",
            "tpm_unstranded",
            "unstranded",
            "tpm",
            "fpkm",
            "log2_expression",
            "estimated_count",
        ],
        allowed_semantics=["expression_value", "normalized_expression", "raw_count"],
        unit_conversions=[],  # no conversion is silently allowed without a rule
        aggregation_policy="keep_all",
        description=(
            "Expression entity/unit normalization: authorize ensembl_gene or "
            "gene_symbol namespaces, accept the declared unit/semantics set, "
            "and require an explicit conversion rule before any unit change."
        ),
    )


NORMALIZATION_PROFILES: dict[str, NormalizationProfile] = {
    _expression_normalization_v1().profile_id: _expression_normalization_v1()
}


def get_normalization_profile(profile_ref: str | None) -> NormalizationProfile:
    """Resolve *profile_ref*; the default expression profile when omitted."""
    if profile_ref is None:
        return NORMALIZATION_PROFILES["gene_expression.normalization.v1"]
    try:
        return NORMALIZATION_PROFILES[profile_ref]
    except KeyError as exc:
        raise KeyError(f"normalization profile {profile_ref!r} is not registered") from exc


# --- validation profile -----------------------------------------------------


@dataclass(frozen=True)
class ProfileCheck:
    """One named check of a validation profile run."""

    check_id: str
    description: str
    passed: bool
    detail: str


class ExpressionValidationProfile:
    """``gene_expression.release.v1`` — server-side acceptance checks.

    Rules live here (and in the versioned profile), never in the Agent or in
    the build chain, so the Agent cannot smuggle acceptance thresholds.

    ``data_confidence`` is a supplementary statistical check (SURVEY §4.1):
    detector thresholds are owned by this Profile (阈值入 Profile), and the
    v1 policy is warning-only — anomalies never flip the release gate, they
    are recorded in ``confidence_report.csv`` and as report warnings until
    the thresholds are calibrated (SURVEY §7).
    """

    profile_id = "gene_expression.release.v1"

    def __init__(self) -> None:
        self.profile = ValidationProfile(
            profile_id=self.profile_id,
            dataset_family="gene_expression",
            acceptance=AcceptancePolicy(
                minimum_valid_rows=1,
                allow_empty_primary_dataset=False,
                allow_partial_publish=True,
            ),
            description=(
                "Expression release gate: primary dataset present with valid "
                "rows, schema-conformant columns, complete required fields, "
                "numeric values, a single unit, and closed provenance."
            ),
        )
        self.confidence_thresholds = ConfidenceThresholds()

    def validate(
        self,
        *,
        manifest: DatasetManifest,
        primary_path: Path,
        schema: DatasetSchema,
        manifest_digest: str,
        output_dir: Path,
    ) -> ValidationResult:
        checks = self._run_checks(manifest, primary_path, schema)
        # The confidence check reads the primary file; skip it when the
        # encoding check already failed (a non-UTF-8 file must not crash it).
        encoding_failed = any(
            check.check_id == "csv_encoding_utf8" and not check.passed
            for check in checks
        )
        if primary_path.is_file() and not encoding_failed:
            confidence_check, warnings = self._run_confidence_check(
                primary_path, output_dir
            )
            checks.append(confidence_check)
        else:
            warnings = []
        report = {
            "profile_ref": self.profile_id,
            "manifest_digest": manifest_digest,
            "checks": [
                {
                    "check_id": check.check_id,
                    "description": check.description,
                    "passed": check.passed,
                    "detail": check.detail,
                }
                for check in checks
            ],
            "warnings": warnings,
        }
        report_path = output_dir / "validation_report.json"
        report_path.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", "utf-8"
        )
        failed = [check for check in checks if not check.passed]
        return ValidationResult(
            manifest_digest=manifest_digest,
            profile_ref=self.profile_id,
            status=(
                ValidationResultStatus.PASSED
                if not failed
                else ValidationResultStatus.FAILED
            ),
            checked_count=len(checks),
            failed_count=len(failed),
            report_path=report_path.relative_to(output_dir).as_posix(),
        )

    def _run_checks(
        self,
        manifest: DatasetManifest,
        primary_path: Path,
        schema: DatasetSchema,
    ) -> list[ProfileCheck]:
        if not primary_path.is_file():
            return [
                ProfileCheck(
                    check_id="primary_dataset_exists",
                    description="primary dataset artifact exists",
                    passed=False,
                    detail=f"missing primary dataset file: {primary_path}",
                )
            ]
        # Encoding is checked first so a non-UTF-8 primary fails fast with a
        # stable single check instead of crashing the downstream readers.
        encoding_check = self._check_csv_encoding(primary_path)
        if not encoding_check.passed:
            return [encoding_check]
        checks: list[ProfileCheck] = [
            self._check_min_rows(manifest, primary_path),
            self._check_column_count(primary_path, schema),
            encoding_check,
        ]
        checks.extend(self._check_rows(primary_path, schema))
        return checks

    def _check_csv_encoding(self, primary_path: Path) -> ProfileCheck:
        """Rule (Design §16 Phase 6): the primary dataset must be UTF-8.

        CSV encoding is a per-profile rule, not an architecture-level gate:
        a non-UTF-8 primary file fails this check and the release gate.
        """
        try:
            primary_path.read_bytes().decode("utf-8")
            passed = True
            detail = "primary dataset decodes as UTF-8"
        except UnicodeDecodeError as exc:
            passed = False
            detail = f"primary dataset is not valid UTF-8: {exc}"
        return ProfileCheck(
            check_id="csv_encoding_utf8",
            description="primary dataset is UTF-8 encoded",
            passed=passed,
            detail=detail,
        )

    def _check_min_rows(
        self, manifest: DatasetManifest, primary_path: Path
    ) -> ProfileCheck:
        minimum = self.profile.acceptance.minimum_valid_rows
        # Count actual data rows in the file (excluding the header), never the
        # manifest-declared row_count: a truncated or header-only file must not
        # vacuous-pass just because the manifest claims enough rows (ADR-011).
        file_rows = 0
        with primary_path.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.reader(handle)
            next(reader, None)  # header
            for _row in reader:
                file_rows += 1
        passed = file_rows >= minimum
        return ProfileCheck(
            check_id="minimum_valid_rows",
            description=f"primary dataset has at least {minimum} row(s)",
            passed=passed,
            detail=f"file_row_count={file_rows}, minimum={minimum}",
        )

    def _check_column_count(self, primary_path: Path, schema: DatasetSchema) -> ProfileCheck:
        with primary_path.open("r", encoding="utf-8", newline="") as handle:
            header = next(csv.reader(handle))
        expected = len(schema.fields)
        passed = len(header) == expected
        return ProfileCheck(
            check_id="column_count_matches_schema",
            description="primary dataset column count matches the schema",
            passed=passed,
            detail=f"actual={len(header)}, schema={expected}",
        )

    def _check_rows(
        self, primary_path: Path, schema: DatasetSchema
    ) -> list[ProfileCheck]:
        required = {
            field.name for field in schema.fields if field.required
        }
        row_count = 0
        malformed_width = 0
        blank_required: dict[str, int] = {}
        non_numeric = 0
        units: set[str] = set()
        missing_provenance = 0
        with primary_path.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.reader(handle)
            header = next(reader, None) or []
            expected = len(header) if header else len(schema.fields)
            for row in reader:
                if not row:
                    continue  # blank lines are not data rows
                row_count += 1
                # B6 (Phase 4 review): reject rows whose parsed field count
                # differs from the header/schema count (extra fields that
                # csv.DictReader would hide under the ``None`` key, or missing
                # cells) BEFORE any field checks. Field checks only apply to
                # well-formed rows, so malformed rows can never vacuous-pass.
                if len(row) != expected:
                    malformed_width += 1
                    continue
                values = dict(zip(header, row, strict=False))
                for field in required:
                    if not values.get(field, "").strip():
                        blank_required[field] = blank_required.get(field, 0) + 1
                try:
                    if not math.isfinite(float(values.get("expression_value", ""))):
                        raise ValueError
                except ValueError:
                    non_numeric += 1
                unit = values.get("expression_unit", "")
                if unit:
                    units.add(unit)
                if not values.get("source_logical_file", "").strip() or not values.get(
                    "asset_id", ""
                ).strip():
                    missing_provenance += 1
        checks = [
            ProfileCheck(
                check_id="row_width_matches_schema",
                description="every row has exactly the schema column count",
                passed=malformed_width == 0,
                detail=(
                    f"{malformed_width} row(s) with a field count != "
                    f"{expected} in {row_count} row(s)"
                ),
            ),
            ProfileCheck(
                check_id="required_field_completeness",
                description="required schema fields are non-blank for every row",
                passed=not blank_required,
                detail=(
                    f"{row_count} row(s); blank required fields: "
                    + (json.dumps(blank_required, sort_keys=True) if blank_required else "none")
                ),
            ),
            ProfileCheck(
                check_id="expression_value_numeric",
                description="expression_value parses as a number for every row",
                passed=non_numeric == 0,
                detail=f"{non_numeric} non-numeric value(s) in {row_count} row(s)",
            ),
            ProfileCheck(
                check_id="unit_consistency",
                description="a single expression unit in the primary dataset",
                passed=len(units) <= 1,
                detail=f"units={sorted(units)}",
            ),
            ProfileCheck(
                check_id="provenance_closure",
                description="every row carries source file and asset provenance",
                passed=missing_provenance == 0,
                detail=f"{missing_provenance} row(s) missing provenance in {row_count} row(s)",
            ),
        ]
        return checks


    def _run_confidence_check(
        self,
        primary_path: Path,
        output_dir: Path,
    ) -> tuple[ProfileCheck, list[dict[str, str]]]:
        """Supplementary statistical check on the primary numeric column.

        Reads ``expression_value`` once, runs the deterministic detectors, and
        writes ``confidence_report.csv``. v1 policy: the check always passes —
        anomalies are surfaced as warnings, never as a failed gate (SURVEY §7).
        """
        values: list[str] = []
        with primary_path.open("r", encoding="utf-8", newline="") as handle:
            for row in csv.DictReader(handle):
                values.append(row.get("expression_value", ""))
        summary = aggregate_confidence_metrics(
            {"expression_value": values},
            thresholds=self.confidence_thresholds,
        )
        report_path = output_dir / "confidence_report.csv"
        write_confidence_report(summary, report_path)
        warnings = [
            {
                "check_id": "data_confidence",
                "detector": finding.detector,
                "column": finding.column,
                "statistic": (
                    "" if finding.statistic is None else f"{finding.statistic:.4f}"
                ),
                "detail": finding.detail,
            }
            for finding in summary.anomalies
        ]
        check = ProfileCheck(
            check_id="data_confidence",
            description=(
                "deterministic statistical detectors (Benford / last digit / "
                "constant / progression) on the primary numeric column"
            ),
            passed=True,  # v1: warning-only, never blocks release
            detail=(
                f"{summary.anomaly_count} anomaly(ies) in {summary.anomalies[0].column}"
                if summary.anomalies
                else "no statistical anomalies detected"
            ),
        )
        return check, warnings


VALIDATION_PROFILES: dict[str, ExpressionValidationProfile] = {
    ExpressionValidationProfile.profile_id: ExpressionValidationProfile()
}


def get_validation_profile(profile_ref: str) -> ExpressionValidationProfile:
    try:
        return VALIDATION_PROFILES[profile_ref]
    except KeyError as exc:
        raise KeyError(f"validation profile {profile_ref!r} is not registered") from exc
