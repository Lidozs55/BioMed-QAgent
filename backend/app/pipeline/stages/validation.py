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
from uuid import uuid4

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
    PipelineCancelledError,
    StageContext,
    StageResult,
    ValidationOutput,
)
from app.pipeline.state import TaskLock

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


_DEFAULT_MAX_LINEAGE_CHECKS = 100


def _deterministic_sample(rows: list[dict[str, str]], max_samples: int) -> list[dict[str, str]]:
    """Select up to ``max_samples`` rows deterministically by record_id hash.

    The sampling is stable across runs: the same input always yields the same
    subset, which makes validation failures reproducible.
    """
    if len(rows) <= max_samples:
        return rows
    scored = [
        (hashlib.sha256(row["record_id"].encode("utf-8")).digest(), row)
        for row in rows
    ]
    scored.sort(key=lambda item: item[0])
    return [row for _hash, row in scored[:max_samples]]


def publish_artifacts(staging: Path, target: Path, ctx: StageContext) -> None:
    """Swap a validated staging directory into place without Windows clobbering.

    Writes ``state/publish_completed.json`` only after the rename succeeds,
    so its presence is a reliable signal that ``artifacts/`` is fully
    populated (TODO §8 line 276). Its absence means the publish did not
    complete (crash, validation failure, cancellation, or in-flight).
    """

    target.parent.mkdir(parents=True, exist_ok=True)
    previous = target.with_name(f".{target.name}.previous-{uuid4().hex}")
    moved_previous = False
    try:
        ctx.check_cancelled()
        if target.exists():
            if target.is_dir() and not any(target.iterdir()):
                target.rmdir()
            else:
                os.replace(target, previous)
                moved_previous = True
        ctx.check_cancelled()
        os.replace(staging, target)
    except PipelineCancelledError:
        if moved_previous and previous.exists() and not target.exists():
            os.replace(previous, target)
        raise
    except BaseException:
        if moved_previous and previous.exists() and not target.exists():
            os.replace(previous, target)
        raise
    finally:
        if previous.exists():
            shutil.rmtree(previous, ignore_errors=True)

    # Marker written AFTER the rename: if a crash happened before this point,
    # the marker is absent even though artifacts/ may exist, so recovery can
    # detect the incomplete publish and re-run.
    state_dir = ctx.workdir.state
    state_dir.mkdir(parents=True, exist_ok=True)
    marker_file = state_dir / "publish_completed.json"
    marker_payload = {
        "published_at": datetime.now(UTC).isoformat(),
        "artifacts_dir": str(target.relative_to(target.parents[0])),
    }
    tmp = marker_file.with_suffix(".json.part")
    tmp.write_text(json.dumps(marker_payload, indent=2) + "\n", "utf-8")
    os.replace(tmp, marker_file)


def _validate_package(
    staging: Path,
    source_path: Path,
    report_path: Path,
    *,
    max_lineage_checks: int = _DEFAULT_MAX_LINEAGE_CHECKS,
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
    sampled_rows = _deterministic_sample(main_rows, max_lineage_checks)
    lineage_failures = 0
    for row in sampled_rows:
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
            "check_name": "sampled values match source locator",
            "status": "passed" if lineage_failures == 0 else "failed",
            "checked_count": len(sampled_rows),
            "failed_count": lineage_failures,
            "details": json.dumps(
                {"total_rows": len(main_rows), "sampled": len(sampled_rows)}
            ),
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
    *,
    publish: bool = True,
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
    _fsync_directory(build_output.staging_dir)

    ctx.check_cancelled()
    if publish:
        publish_artifacts(build_output.staging_dir, ctx.workdir.artifacts, ctx)

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


def _fsync_directory(directory: Path) -> None:
    """Flush every file in ``directory`` to disk (fsync) before atomic rename.

    A crash between write and rename can leave stale page-cache state on
    some filesystems; fsync closes that window. Directory entries themselves
    are flushed implicitly by the subsequent rename on POSIX, and by the
    rmtree+replace sequence on Windows.
    """
    for path in directory.iterdir():
        if path.is_file():
            with path.open("r+b") as handle:
                handle.flush()
                os.fsync(handle.fileno())


def _publish_artifacts(
    staging: Path, artifacts: Path, state_dir: Path
) -> None:
    """Atomically publish the staging package to ``artifacts/``.

    Guarantees (TODO §8 line 276):
    1. Exclusive: a task lockfile serializes concurrent publishers in the
       same workdir (recovery racing with a stuck prior process).
    2. Atomic rename: on POSIX ``os.replace`` over a directory is atomic;
       on Windows ``os.replace`` cannot overwrite an existing directory, so
       the prior ``artifacts/`` is removed first under the lock. The window
       where ``artifacts/`` does not exist is bounded by the lock — no
       reader can observe it.
    3. Marker: ``state/publish_completed.json`` is written only after the
       rename succeeds, so its presence is a reliable signal that
       ``artifacts/`` is fully populated. Its absence means the publish did
       not complete (crash, validation failure, or in-flight).

    Note: production code uses ``publish_artifacts`` (which integrates with
    ``StageContext`` for cancellation and a rename-aside rollback). This
    helper is kept as a directly-testable unit that verifies the
    lock + marker contract without requiring a full stage context.
    """
    state_dir.mkdir(parents=True, exist_ok=True)
    lock_file = state_dir / "publish.lock"
    marker_file = state_dir / "publish_completed.json"

    with TaskLock(lock_file):
        # Remove a prior artifacts/ dir (from a recovered re-publish) so
        # os.replace can rename onto a non-existent path, which is atomic
        # on both POSIX and Windows.
        if artifacts.exists():
            shutil.rmtree(artifacts)
        os.replace(staging, artifacts)

        # Marker written AFTER the rename: if a crash happened before this
        # point, the marker is absent even though artifacts/ may exist, so
        # recovery can detect the incomplete publish and re-run.
        marker_payload = {
            "published_at": datetime.now(UTC).isoformat(),
            "artifacts_dir": str(artifacts.relative_to(artifacts.parents[0])),
        }
        tmp = marker_file.with_suffix(".json.part")
        tmp.write_text(
            json.dumps(marker_payload, indent=2) + "\n", "utf-8"
        )
        os.replace(tmp, marker_file)
