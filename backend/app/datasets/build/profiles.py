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
    ProbeMappingSummary,
    ValidationProfile,
    ValidationResult,
    ValidationResultStatus,
    ValueScale,
)


def _value_field(schema: DatasetSchema) -> str:
    """The schema's per-record numeric measurement column.

    The gene schema declares ``expression_value``; the probe-level schema
    (``gene_expression.probe_long.v1``) declares ``value``.  Both mark the
    field with ``unit_policy="declared_per_record"``, so the column is
    derived from the schema metadata — never hardcoded per schema id.
    """
    for field in schema.fields:
        if field.unit_policy == "declared_per_record":
            return field.name
    return "expression_value"

# --- normalization profiles -------------------------------------------------


def _expression_normalization_v1() -> NormalizationProfile:
    return NormalizationProfile(
        profile_id="gene_expression.normalization.v1",
        dataset_family="gene_expression",
        allowed_namespaces=["ensembl_gene", "gene_symbol", "geo_probe"],
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
        # Phase 5 D3/T4: every scale the expression chain may honestly declare.
        # GDC/Xena emit ``linear``; GEO series matrices declare ``log2`` or
        # ``unknown``; supplementary matrices ``linear``.  ``unknown`` is
        # explicit: a scale that cannot be proven is declared, never guessed.
        allowed_value_scales=[
            ValueScale.LINEAR,
            ValueScale.LOG2,
            ValueScale.LOG10,
            ValueScale.UNKNOWN,
        ],
        unit_conversions=[],  # no conversion is silently allowed without a rule
        aggregation_policy="keep_all",
        description=(
            "Expression entity/unit normalization: authorize ensembl_gene, "
            "gene_symbol and geo_probe namespaces, accept the declared "
            "unit/semantics/scale sets, and require an explicit conversion "
            "rule before any unit change.  geo_probe is an honest "
            "adapter-declared namespace for probe rows; the entity-level "
            "publish policy (residual geo_probe rows fail the gene release "
            "gate) lives in the validation profile (Phase 5 T7)."
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

    ``required_entity_level`` (Phase 5 D4) is the entity level this profile's
    release gate requires; the Spec Validator enforces its compatibility with
    the build's schema/target.
    """

    profile_id = "gene_expression.release.v1"
    required_entity_level = "gene"

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
            required_entity_level=self.required_entity_level,
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
        probe_mapping_summaries: list[ProbeMappingSummary] | None = None,
    ) -> ValidationResult:
        checks = self._run_checks(
            manifest, primary_path, schema, probe_mapping_summaries
        )
        # The confidence check reads the primary file; skip it when the
        # encoding check already failed (a non-UTF-8 file must not crash it).
        encoding_failed = any(
            check.check_id == "csv_encoding_utf8" and not check.passed
            for check in checks
        )
        if primary_path.is_file() and not encoding_failed:
            confidence_check, confidence_warnings = self._run_confidence_check(
                primary_path, output_dir, schema
            )
            checks.append(confidence_check)
        else:
            confidence_warnings = []
        # Phase 5 D4/T5: probe-level builds surface probe-coverage as warnings
        # (data_confidence-style) instead of failing the release gate.
        warnings = confidence_warnings + self._probe_coverage_warnings(
            probe_mapping_summaries
        )
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
        probe_mapping_summaries: list[ProbeMappingSummary] | None = None,
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
        # Phase 5 D4/T5: ``required_entity_level == "gene"`` demands complete
        # probe→gene coverage — any residual geo_probe/ambiguous row fails the
        # release gate (output-integrity semantics, not a calibrated
        # threshold). Probe-level profiles skip this and warn instead.
        if self.required_entity_level == "gene":
            checks.append(
                self._check_probe_coverage_required_gene_level(
                    primary_path, probe_mapping_summaries
                )
            )
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
        value_field = _value_field(schema)
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
                    if not math.isfinite(float(values.get(value_field, ""))):
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
                description=f"{value_field} parses as a number for every row",
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

    def _check_probe_coverage_required_gene_level(
        self,
        primary_path: Path,
        summaries: list[ProbeMappingSummary] | None,
    ) -> ProfileCheck:
        """Phase 5 D4: gene-required builds need complete probe→gene coverage.

        Any residual ``geo_probe``/ambiguous row in the primary, or any
        binding whose ``ProbeMappingSummary`` coverage is below 1.0, fails the
        release gate.  The 1.0 requirement is server-owned output-integrity
        semantics (D4), never a calibrated threshold the Agent can pass.
        Builds with no probes at all (e.g. GDC/Xena gene sources) have no
        residual rows and no summaries, so they are unaffected.
        """
        residual = self._count_residual_geo_probe_rows(primary_path)
        below_one: list[str] = []
        if summaries:
            for summary in summaries:
                if summary.total_probe_count > 0 and not math.isclose(
                    summary.coverage_ratio, 1.0, rel_tol=0.0, abs_tol=1e-9
                ):
                    below_one.append(summary.binding_id)
        passed = residual == 0 and not below_one
        detail = f"residual_geo_probe_rows={residual}"
        if summaries:
            detail += f"; coverage_below_1.0={below_one if below_one else 'none'}"
        return ProfileCheck(
            check_id="probe_coverage_required_gene_level",
            description=(
                "gene-required build: probe→gene coverage must be 1.0 with "
                "no residual geo_probe/ambiguous rows in the primary dataset"
            ),
            passed=passed,
            detail=detail,
        )

    def _count_residual_geo_probe_rows(self, primary_path: Path) -> int:
        """Count primary rows whose ``gene_id_namespace`` is still ``geo_probe``.

        Ambiguous probes remain ``geo_probe`` (D2), so this scan covers both
        unmapped and ambiguous residual rows in one pass.
        """
        residual = 0
        with primary_path.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                if row.get("gene_id_namespace", "").strip() == "geo_probe":
                    residual += 1
        return residual

    def _probe_coverage_warnings(
        self, summaries: list[ProbeMappingSummary] | None
    ) -> list[dict[str, str]]:
        """Phase 5 D4: probe-level builds surface coverage as warnings only.

        A probe-level build publishes any coverage (0 included) as honest
        ``geo_probe`` data plus audit; the warning mirrors the
        ``data_confidence`` policy and never blocks release.
        """
        if self.required_entity_level != "probe" or not summaries:
            return []
        warnings: list[dict[str, str]] = []
        for summary in summaries:
            warnings.append(
                {
                    "check_id": "probe_coverage",
                    "binding_id": summary.binding_id,
                    "platform_id": summary.platform_id or "",
                    "mapping_status": summary.mapping_status.value,
                    "coverage_ratio": f"{summary.coverage_ratio:.4f}",
                    "detail": (
                        f"probe-level build: probe→gene coverage "
                        f"{summary.coverage_ratio:.4f} (mapped "
                        f"{summary.mapped_probe_count}/"
                        f"{summary.total_probe_count}) is publishable at probe "
                        "level (warning-only; entity policy requires probe)"
                    ),
                }
            )
        return warnings

    def _run_confidence_check(
        self,
        primary_path: Path,
        output_dir: Path,
        schema: DatasetSchema,
    ) -> tuple[ProfileCheck, list[dict[str, str]]]:
        """Supplementary statistical check on the primary numeric column.

        Reads the schema's value field once (``expression_value`` for the gene
        schema, ``value`` for the probe schema), runs the deterministic
        detectors, and writes ``confidence_report.csv``. v1 policy: the check
        always passes — anomalies are surfaced as warnings, never as a failed
        gate (SURVEY §7).
        """
        values: list[str] = []
        value_field = _value_field(schema)
        with primary_path.open("r", encoding="utf-8", newline="") as handle:
            for row in csv.DictReader(handle):
                values.append(row.get(value_field, ""))
        summary = aggregate_confidence_metrics(
            {value_field: values},
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


class ProbeExpressionValidationProfile(ExpressionValidationProfile):
    """``gene_expression.probe_release.v1`` — probe-level release gate.

    Same server-side checks as the gene profile; ``required_entity_level`` is
    ``probe`` (Phase 5 D4), which drives the Spec Validator's entity-level
    compatibility check (and, in T5, the probe-coverage policy matrix).
    """

    profile_id = "gene_expression.probe_release.v1"
    required_entity_level = "probe"


VALIDATION_PROFILES: dict[str, ExpressionValidationProfile] = {
    ExpressionValidationProfile.profile_id: ExpressionValidationProfile(),
    ProbeExpressionValidationProfile.profile_id: ProbeExpressionValidationProfile(),
}


def get_validation_profile(profile_ref: str) -> ExpressionValidationProfile:
    try:
        return VALIDATION_PROFILES[profile_ref]
    except KeyError as exc:
        raise KeyError(f"validation profile {profile_ref!r} is not registered") from exc
