"""Validation package orchestration.

``validate_package`` (formerly ``_validate_package``) loads the staging CSVs
into a ``ValidationContext``, runs every per-scope check in the historic
order, writes ``validation_report.json``, and returns the summary plus the
check list. The check ordering is load-bearing: the regression test in
``tests/pipeline/test_validation_split.py`` pins the exact check_id sequence
for both GEO and Reactome packages.
"""
from __future__ import annotations

import json
from pathlib import Path

from app.domain.contracts import ValidationSummary
from app.pipeline.stages.validation.checks.lineage import check_source_value_lineage
from app.pipeline.stages.validation.checks.main_data import (
    check_cleaning_report_consistency,
    check_core_data_existence,
    check_field_descriptions,
    check_foreign_keys,
    check_main_data_nonempty,
    check_no_primary_data,
    check_warnings_metrics_consistency,
)
from app.pipeline.stages.validation.checks.reactome import check_reactome
from app.pipeline.stages.validation.checks.relations import check_source_relation_evidence
from app.pipeline.stages.validation.checks.sample_metadata import (
    check_sample_foreign_keys,
)
from app.pipeline.stages.validation.checks.source_assets import (
    check_source_asset_integrity,
)
from app.pipeline.stages.validation.checks_common import (
    DEFAULT_MAX_LINEAGE_CHECKS,
    load_validation_context,
)


def validate_package(
    staging: Path,
    source_path: Path,
    report_path: Path,
    *,
    max_lineage_checks: int | None = DEFAULT_MAX_LINEAGE_CHECKS,
) -> tuple[ValidationSummary, list[dict[str, object]]]:
    """Run all validation checks on the staging package.

    Loads the staging CSVs once into a ``ValidationContext``, then runs the
    per-scope checks in the historic order so the emitted ``check_id``
    sequence is stable. Writes ``validation_report.json`` and returns the
    summary plus the check list.
    """
    ctx = load_validation_context(
        staging,
        source_path,
        report_path,
        max_lineage_checks=max_lineage_checks,
    )

    checks: list[dict[str, object]] = []
    if ctx.no_primary:
        # Phase 4b NO_DATA mode (ADR-011 / design D3): no primary table
        # exists (neither main_data.csv nor pathway_members.csv), so the
        # main-table checks are skipped entirely and a ``no_primary_data``
        # decision record is emitted instead. The decision check asserts the
        # no-primary shape and records the reason from warnings.csv; the
        # remaining checks run unchanged. This is a SEPARATE branch — the
        # normal-mode check_id sequence stays byte-identical (pinned by
        # tests/pipeline/test_validation_split.py).
        checks.append(check_source_relation_evidence(ctx))
        checks.append(check_no_primary_data(ctx))
        checks.append(check_sample_foreign_keys(ctx))
        checks.append(check_source_asset_integrity(ctx))
        checks.append(check_field_descriptions(ctx))
        checks.append(check_warnings_metrics_consistency(ctx))
        checks.append(check_cleaning_report_consistency(ctx))
    else:
        checks.append(check_source_relation_evidence(ctx))
        checks.append(check_main_data_nonempty(ctx))
        checks.append(check_core_data_existence(ctx))
        checks.append(check_foreign_keys(ctx))
        checks.extend(check_reactome(ctx))
        checks.append(check_sample_foreign_keys(ctx))
        checks.append(check_source_asset_integrity(ctx))
        checks.append(check_field_descriptions(ctx))
        checks.append(check_source_value_lineage(ctx))
        checks.append(check_warnings_metrics_consistency(ctx))
        checks.append(check_cleaning_report_consistency(ctx))

    total_failed = sum(int(check["failed_count"]) for check in checks)
    report = {
        "schema_version": "1.0",
        "status": "valid" if total_failed == 0 else "invalid",
        "checks": checks,
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", "utf-8")
    return ValidationSummary(
        status=report["status"],
        checked_count=sum(int(check["checked_count"]) for check in checks),
        failed_count=total_failed,
        report_path=report_path.relative_to(report_path.parents[1]).as_posix(),
    ), checks


# Backward-compat alias: tests and callers import ``_validate_package`` from
# the validation package. Kept so the split is a pure structural refactoring.
_validate_package = validate_package
