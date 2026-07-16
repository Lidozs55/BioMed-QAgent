"""Validation gate stage: validate staging package and publish artifacts."""
from __future__ import annotations

import csv
import gzip
import hashlib
import json
import os
import shutil
from datetime import UTC, datetime
from pathlib import Path

from app.domain.contracts import (
    ArtifactManifestEntry,
    RunManifest,
    StageAttempt,
    TaskRequest,
    TaskState,
    ValidationSummary,
)
from app.pipeline.stages.base import (
    ArtifactBuildOutput,
    StageContext,
    StageResult,
    ValidationOutput,
)

_ARTIFACT_COLUMNS_QUALITY = [
    "check_id", "scope", "check_name", "status",
    "checked_count", "failed_count", "details",
]


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def _write_csv(path: Path, columns: list[str], rows: list[dict[str, object]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _validate_package(
    staging: Path,
    source_path: Path,
    report_path: Path,
) -> tuple[ValidationSummary, list[dict[str, object]]]:
    """Run all validation checks on the staging package."""
    main_rows = _read_csv(staging / "main_data.csv")
    dataset_ids = {
        row["dataset_id"] for row in _read_csv(staging / "dataset_catalog.csv")
    }
    sample_rows = _read_csv(staging / "sample_metadata.csv")
    sample_ids = {row["sample_id"] for row in sample_rows}
    source_ids = {row["source_id"] for row in _read_csv(staging / "source_list.csv")}
    asset_rows = _read_csv(staging / "source_assets.csv")
    asset_ids = {row["asset_id"] for row in asset_rows}
    download_rows = _read_csv(staging / "download_log.csv")
    described = {
        row["field_name"] for row in _read_csv(staging / "field_descriptions.csv")
    }

    checks: list[dict[str, object]] = []
    reference_failures = sum(
        row["dataset_id"] not in dataset_ids
        or row["sample_id"] not in sample_ids
        or row["source_id"] not in source_ids
        or row["asset_id"] not in asset_ids
        for row in main_rows
    )
    checks.append(
        {
            "check_id": "foreign_keys",
            "scope": "main_data",
            "check_name": "foreign key closure",
            "status": "passed" if reference_failures == 0 else "failed",
            "checked_count": len(main_rows),
            "failed_count": reference_failures,
            "details": "",
        }
    )
    sample_reference_failures = sum(
        row["dataset_id"] not in dataset_ids or row["source_id"] not in source_ids
        for row in sample_rows
    )
    checks.append(
        {
            "check_id": "sample_foreign_keys",
            "scope": "sample_metadata",
            "check_name": "sample dataset and source closure",
            "status": "passed" if sample_reference_failures == 0 else "failed",
            "checked_count": len(sample_rows),
            "failed_count": sample_reference_failures,
            "details": "",
        }
    )
    successful_attempt_ids = {
        row["attempt_id"] for row in download_rows if row["status"] == "succeeded"
    }
    asset_failures = 0
    for row in asset_rows:
        asset_failures += (
            row["successful_attempt_id"] not in successful_attempt_ids
            or row["source_id"] not in source_ids
            or row["relative_path"]
            != source_path.relative_to(source_path.parents[1]).as_posix()
            or int(row["size_bytes"]) != source_path.stat().st_size
            or row["sha256"] != _sha256(source_path)
        )
    checks.append(
        {
            "check_id": "source_asset_integrity",
            "scope": "source_assets",
            "check_name": "source asset file, checksum, and successful attempt",
            "status": "passed" if asset_failures == 0 else "failed",
            "checked_count": len(asset_rows),
            "failed_count": asset_failures,
            "details": "",
        }
    )
    missing_fields = set(main_rows[0]) - described if main_rows else set()
    checks.append(
        {
            "check_id": "field_descriptions",
            "scope": "main_data",
            "check_name": "every field is described",
            "status": "passed" if not missing_fields else "failed",
            "checked_count": len(main_rows[0]) if main_rows else 0,
            "failed_count": len(missing_fields),
            "details": json.dumps(sorted(missing_fields)),
        }
    )

    with gzip.open(source_path, "rt", encoding="utf-8", newline="") as handle:
        source_lines = list(csv.reader(handle, delimiter="\t", quotechar='"'))
    lineage_failures = 0
    for row in main_rows:
        line_index = int(row["source_line_number"]) - 1
        column_index = int(row["source_column_index"])
        try:
            raw = source_lines[line_index][column_index]
        except (IndexError, ValueError):
            lineage_failures += 1
            continue
        if raw != row["source_raw_value"] or float(raw) != float(
            row["expression_value"]
        ):
            lineage_failures += 1
    checks.append(
        {
            "check_id": "source_value_lineage",
            "scope": "main_data",
            "check_name": "every pinned value matches its source locator",
            "status": "passed" if lineage_failures == 0 else "failed",
            "checked_count": len(main_rows),
            "failed_count": lineage_failures,
            "details": "",
        }
    )
    # Warnings ↔ processing-log metrics consistency.
    # warnings.csv row count must equal the total warnings recorded in
    # processing_log.csv ``warnings`` JSON arrays.
    warnings_path = staging / "warnings.csv"
    warning_rows = _read_csv(warnings_path) if warnings_path.is_file() else []
    proc_log_path = staging / "processing_log.csv"
    processing_rows = _read_csv(proc_log_path) if proc_log_path.is_file() else []
    logged_warning_count = 0
    for prow in processing_rows:
        raw = prow.get("warnings", "[]")
        try:
            logged_warning_count += len(json.loads(raw))
        except (json.JSONDecodeError, TypeError):
            logged_warning_count += 0
    warning_mismatch = abs(len(warning_rows) - logged_warning_count)
    checks.append(
        {
            "check_id": "warnings_metrics_consistency",
            "scope": "warnings",
            "check_name": "warnings.csv count matches processing_log warnings count",
            "status": "passed" if warning_mismatch == 0 else "failed",
            "checked_count": len(warning_rows) + logged_warning_count,
            "failed_count": warning_mismatch,
            "details": "",
        }
    )
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


def run_validation(
    ctx: StageContext,
    build_output: ArtifactBuildOutput,
    stage_attempts: list[StageAttempt],
    stage_attempt_id: str,
) -> StageResult:
    """Validate the staging package and publish artifacts atomically.

    Runs all validation checks, writes ``quality_report.csv``, and if valid
    performs the atomic rename from ``staging/`` to ``artifacts/``.
    """
    validation, checks = _validate_package(
        build_output.staging_dir,
        build_output.source_path,
        ctx.workdir.logs / "validation_report.json",
    )
    _write_csv(
        build_output.staging_dir / "quality_report.csv",
        _ARTIFACT_COLUMNS_QUALITY,
        checks,
    )
    if validation.status != "valid":
        raise ValueError(
            f"validation gate rejected the package: {validation.failed_count} failure(s)"
        )

    entries: list[ArtifactManifestEntry] = []
    for path in sorted(build_output.staging_dir.iterdir(), key=lambda item: item.name):
        checksum_value = _sha256(path)
        entries.append(
            ArtifactManifestEntry(
                artifact_id=f"artifact_{checksum_value[:32]}",
                name=path.name,
                relative_path=f"artifacts/{path.name}",
                media_type="text/csv",
                size_bytes=path.stat().st_size,
                sha256=checksum_value,
                generated_by_step_id="step_artifact_builder_v1",
            )
        )
    entries.sort(key=lambda entry: entry.artifact_id)

    manifest = RunManifest(
        task_id=ctx.task_id,
        id_generation_version="1.0",
        request=TaskRequest(topic=build_output.specification.topic, mode=ctx.mode),
        specification=build_output.specification,
        task_state=TaskState.COMPLETED,
        stage_attempt_ids=sorted(
            {attempt.stage_attempt_id for attempt in stage_attempts} | {stage_attempt_id}
        ),
        source_ids=sorted(s.source_id for s in build_output.sources),
        artifacts=entries,
        validation=validation,
        pipeline_version="0.1.0",
        model_name=None,
        mode=ctx.mode,
        live_accepted=ctx.mode == "live" and validation.status == "valid",
        started_at=ctx.started_at,
        finished_at=datetime.now(UTC),
    )
    (build_output.staging_dir / "run_manifest.json").write_text(
        manifest.model_dump_json(indent=2) + "\n", "utf-8"
    )

    # Flush all staging files to disk before the atomic rename so a crash
    # between write and rename cannot leave stale page-cache state.
    for path in build_output.staging_dir.iterdir():
        if path.is_file():
            with path.open("r+b") as handle:
                handle.flush()
                os.fsync(handle.fileno())

    # Publish: rename the validated staging package to artifacts/.
    # On Windows, os.replace CANNOT overwrite an existing directory
    # (MoveFileEx with MOVEFILE_REPLACE_EXISTING only supports files), so a
    # prior artifacts/ dir — from a recovered re-publish — must be removed
    # first. Renaming onto a non-existent path is atomic on both POSIX and
    # Windows. The fully atomic publish with a task lock is tracked as
    # TODO §8 (line 276); this preserves the prior safety level.
    if ctx.workdir.artifacts.exists():
        shutil.rmtree(ctx.workdir.artifacts)
    os.replace(build_output.staging_dir, ctx.workdir.artifacts)

    output = ValidationOutput(
        validation=validation,
        artifacts=entries,
        manifest=manifest,
    )
    digest = hashlib.sha256(
        json.dumps(
            [e.artifact_id for e in entries], separators=(",", ":")
        ).encode("utf-8")
    ).hexdigest()
    return StageResult(output_digest=digest, output=output)
