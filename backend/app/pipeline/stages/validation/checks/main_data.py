"""Main-data and package-consistency validation checks.

Holds the checks that run for every package (not just Reactome): main-data
non-empty, foreign-key closure, field-description coverage, and the
warnings/cleaning-report consistency checks.
"""
from __future__ import annotations

import json

from app.pipeline.stages.validation.checks_common import ValidationContext, read_csv


def check_main_data_nonempty(ctx: ValidationContext) -> dict[str, object]:
    """main_data contains at least one record."""
    main_rows = ctx.main_rows
    return {
        "check_id": "main_data_nonempty",
        "scope": "main_data",
        "check_name": "main data contains at least one record",
        "status": "passed" if main_rows else "failed",
        "checked_count": len(main_rows),
        "failed_count": 0 if main_rows else 1,
        "details": "",
    }


def check_foreign_keys(ctx: ValidationContext) -> dict[str, object]:
    """Foreign-key closure for main_data dataset/sample/source/asset."""
    main_rows = ctx.main_rows
    reference_failures = sum(
        row["dataset_id"] not in ctx.dataset_ids
        or (not ctx.reactome_rows and row["sample_id"] not in ctx.sample_ids)
        or row["source_id"] not in ctx.source_ids
        or row["asset_id"] not in ctx.asset_ids
        for row in main_rows
    )
    return {
        "check_id": "foreign_keys",
        "scope": "main_data",
        "check_name": "foreign key closure",
        "status": "passed" if reference_failures == 0 else "failed",
        "checked_count": len(main_rows),
        "failed_count": reference_failures,
        "details": "",
    }


def check_field_descriptions(ctx: ValidationContext) -> dict[str, object]:
    """Every main_data column must be described in field_descriptions.csv."""
    main_rows = ctx.main_rows
    missing_fields = set(main_rows[0]) - ctx.described if main_rows else set()
    return {
        "check_id": "field_descriptions",
        "scope": "main_data",
        "check_name": "every field is described",
        "status": "passed" if not missing_fields else "failed",
        "checked_count": len(main_rows[0]) if main_rows else 0,
        "failed_count": len(missing_fields),
        "details": json.dumps(sorted(missing_fields)),
    }


def check_warnings_metrics_consistency(ctx: ValidationContext) -> dict[str, object]:
    """warnings.csv row count must equal total warnings in processing_log.csv.

    warnings.csv row count must equal the total warnings recorded in
    processing_log.csv ``warnings`` JSON arrays.
    """
    warnings_path = ctx.staging / "warnings.csv"
    warning_rows = read_csv(warnings_path) if warnings_path.is_file() else []
    proc_log_path = ctx.staging / "processing_log.csv"
    processing_rows = read_csv(proc_log_path) if proc_log_path.is_file() else []
    logged_warning_count = 0
    for prow in processing_rows:
        raw = prow.get("warnings", "[]")
        try:
            logged_warning_count += len(json.loads(raw))
        except (json.JSONDecodeError, TypeError):
            logged_warning_count += 0
    warning_mismatch = abs(len(warning_rows) - logged_warning_count)
    return {
        "check_id": "warnings_metrics_consistency",
        "scope": "warnings",
        "check_name": "warnings.csv count matches processing_log warnings count",
        "status": "passed" if warning_mismatch == 0 else "failed",
        "checked_count": len(warning_rows) + logged_warning_count,
        "failed_count": warning_mismatch,
        "details": "",
    }


def check_cleaning_report_consistency(ctx: ValidationContext) -> dict[str, object]:
    """cleaning_report.csv anomaly counts match warnings.csv cleaning entries.

    Verifies cleaning_report.csv exists and its anomaly counts are consistent
    with warnings.csv cleaning entries.
    """
    cleaning_path = ctx.staging / "cleaning_report.csv"
    cleaning_report_exists = cleaning_path.is_file()
    cleaning_rows = read_csv(cleaning_path) if cleaning_report_exists else []
    warnings_path = ctx.staging / "warnings.csv"
    warning_rows = read_csv(warnings_path) if warnings_path.is_file() else []
    cleaning_warnings = [
        w for w in warning_rows
        if w.get("code") in {"missing_values", "duplicate_rows", "type_inconsistency"}
    ]
    cleaning_missing = sum(
        1 for r in cleaning_rows if r.get("rule") == "missing_values"
    )
    cleaning_dup = any(r.get("rule") == "duplicate_rows" for r in cleaning_rows)
    cleaning_type = sum(
        1 for r in cleaning_rows if r.get("rule") == "type_inconsistency"
    )
    cleaning_warn_count = len(cleaning_warnings)
    cleaning_expected = cleaning_missing + (1 if cleaning_dup else 0) + cleaning_type
    cleaning_mismatch = abs(cleaning_expected - cleaning_warn_count)
    cleaning_failures = cleaning_mismatch + (0 if cleaning_report_exists else 1)
    return {
        "check_id": "cleaning_report_consistency",
        "scope": "cleaning",
        "check_name": "cleaning_report.csv anomaly counts match warnings.csv cleaning entries",
        "status": "passed" if cleaning_failures == 0 else "failed",
        "checked_count": cleaning_expected + cleaning_warn_count + 1,
        "failed_count": cleaning_failures,
        "details": "",
    }
