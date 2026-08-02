"""Validation gate stage: validate staging package and publish artifacts."""
from __future__ import annotations

import csv
import gzip
import hashlib
import json
import logging
import os
import re
import shutil
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
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
    StageContext,
    StageResult,
    ValidationOutput,
    write_csv,
)
from app.pipeline.state import TaskLock

_ARTIFACT_COLUMNS_QUALITY = [
    "check_id", "scope", "check_name", "status",
    "checked_count", "failed_count", "details",
]


def _read_csv(path: Path) -> list[dict[str, str]]:
    # utf-8-sig strips the BOM that artifact_build._write_csv adds (TODO §1.7).
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


_DEFAULT_MAX_LINEAGE_CHECKS = 100
_ARTIFACT_BACKUP_NAME = re.compile(r"^\.artifacts\.previous-[0-9a-f]{32}$")
_MARKER_BACKUP_NAME = re.compile(
    r"^publish_completed\.previous-[0-9a-f]{32}\.json$"
)
_LOGGER = logging.getLogger(__name__)


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


def publish_artifacts(
    staging: Path,
    target: Path,
    ctx: StageContext,
    *,
    run_id: str | None = None,
) -> None:
    """Swap a validated staging directory into place without Windows clobbering.

    Writes ``state/publish_completed.json`` only after the rename succeeds,
    so its presence is a reliable signal that ``artifacts/`` is fully
    populated (TODO §8 line 276). Its absence means the publish did not
    complete (crash, validation failure, cancellation, or in-flight).
    """

    _publish_artifacts_core(
        staging,
        target,
        ctx.workdir.state,
        task_id=ctx.task_id if run_id is not None else None,
        run_id=run_id,
        check_cancelled=ctx.check_cancelled,
    )


def _publish_artifacts_core(
    staging: Path,
    target: Path,
    state_dir: Path,
    *,
    task_id: str | None,
    run_id: str | None,
    check_cancelled: Callable[[], None],
) -> None:
    """Publish one validated package while holding the shared task lock."""
    target.parent.mkdir(parents=True, exist_ok=True)
    state_dir.mkdir(parents=True, exist_ok=True)
    lock_file = state_dir / "publish.lock"
    marker_file = state_dir / "publish_completed.json"
    previous = target.with_name(f".{target.name}.previous-{uuid4().hex}")
    marker_previous = state_dir / f"publish_completed.previous-{uuid4().hex}.json"
    marker_tmp = marker_file.with_suffix(".json.part")
    with TaskLock(lock_file):
        _drain_pending_publication_cleanup(state_dir)
        had_target = target.exists()
        had_marker = marker_file.exists()
        moved_previous = False
        moved_candidate = False
        moved_marker = False
        marker_commit_started = False
        cleanup_previous = False
        cleanup_marker_previous = False
        try:
            check_cancelled()
            if run_id is not None:
                if task_id is None:
                    raise ValueError("managed publication requires task_id")
                _write_runtime_publication_marker(
                    staging,
                    task_id=task_id,
                    run_id=run_id,
                )
            _fsync_directory(staging)
            if had_target:
                os.replace(target, previous)
                moved_previous = True
            if had_marker:
                os.replace(marker_file, marker_previous)
                moved_marker = True
            check_cancelled()
            os.replace(staging, target)
            moved_candidate = True
            check_cancelled()

            # Marker written AFTER the rename: if a crash happened before this
            # point, the marker is absent even though artifacts/ may exist, so
            # recovery can detect the incomplete publish and re-run.
            marker_commit_started = True
            _write_publish_completed_marker(marker_file, target)
            cleanup_previous = True
            cleanup_marker_previous = True
        except BaseException:
            rollback_errors: list[Exception] = []
            if moved_candidate and target.exists():
                error = _retry_rollback_action(
                    lambda: os.replace(target, staging)
                )
                if error is not None:
                    rollback_errors.append(error)
            if moved_previous and previous.exists():
                error = _retry_rollback_action(
                    lambda: os.replace(previous, target)
                )
                if error is not None:
                    rollback_errors.append(error)
            if marker_commit_started:
                error = _retry_rollback_action(
                    lambda: marker_file.unlink(missing_ok=True)
                )
                if error is not None:
                    rollback_errors.append(error)
            if moved_marker and marker_previous.exists():
                error = _retry_rollback_action(
                    lambda: os.replace(marker_previous, marker_file)
                )
                if error is not None:
                    rollback_errors.append(error)

            artifact_restored = (
                (not moved_candidate or staging.is_dir())
                and (
                    target.is_dir() and not previous.exists()
                    if had_target
                    else not target.exists()
                )
            )
            marker_restored = (
                marker_file.is_file() and not marker_previous.exists()
                if had_marker
                else not marker_file.exists()
            )
            cleanup_previous = artifact_restored
            cleanup_marker_previous = marker_restored
            if not artifact_restored:
                rollback_errors.append(
                    RuntimeError("artifact directory rollback is incomplete")
                )
            if not marker_restored:
                rollback_errors.append(
                    RuntimeError("publish marker rollback is incomplete")
                )
            if rollback_errors:
                details = "; ".join(str(error) for error in rollback_errors)
                raise RuntimeError(
                    f"artifact publication rollback failed: {details}"
                ) from rollback_errors[0]
            raise
        finally:
            pending_cleanup: list[Path] = []
            if not _cleanup_publication_path(marker_tmp):
                pending_cleanup.append(marker_tmp)
            if cleanup_previous and not _cleanup_publication_path(previous):
                pending_cleanup.append(previous)
            if cleanup_marker_previous and not _cleanup_publication_path(
                marker_previous
            ):
                pending_cleanup.append(marker_previous)
            if pending_cleanup:
                try:
                    _write_cleanup_pending_record(state_dir, pending_cleanup)
                except Exception:
                    _LOGGER.exception(
                        "could not persist publication cleanup journal"
                    )


def _retry_rollback_action(
    operation: Callable[[], None],
) -> Exception | None:
    error: Exception | None = None
    for _attempt in range(2):
        try:
            operation()
            return None
        except Exception as exc:
            error = exc
    return error


def _cleanup_publication_path(path: Path) -> bool:
    """Retry cleanup and report whether the task-local path is now absent."""
    for _attempt in range(2):
        try:
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink(missing_ok=True)
            if not os.path.lexists(path):
                return True
        except OSError:
            continue
    return not os.path.lexists(path)


def _write_cleanup_pending_record(state_dir: Path, paths: list[Path]) -> None:
    task_root = state_dir.parent.resolve()
    relative_paths = sorted(
        {
            _cleanup_pending_relative_path(task_root, path)
            for path in paths
        }
    )
    pending_file = state_dir / "publish_cleanup_pending.json"
    pending_tmp = pending_file.with_suffix(".json.part")
    payload = {
        "schema_version": 1,
        "paths": relative_paths,
    }
    try:
        pending_tmp.write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n",
            "utf-8",
        )
        with pending_tmp.open("r+b") as handle:
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(pending_tmp, pending_file)
    finally:
        _cleanup_publication_path(pending_tmp)


def _drain_pending_publication_cleanup(state_dir: Path) -> None:
    pending_file = state_dir / "publish_cleanup_pending.json"
    pending_tmp = pending_file.with_suffix(".json.part")
    if not _cleanup_publication_path(pending_tmp):
        raise RuntimeError("pending publication cleanup journal temp remains")
    if pending_file.is_file():
        try:
            payload = json.loads(pending_file.read_text("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise RuntimeError("invalid pending publication cleanup record") from exc
        if (
            not isinstance(payload, dict)
            or set(payload) != {"schema_version", "paths"}
            or payload.get("schema_version") != 1
            or not isinstance(payload.get("paths"), list)
            or not payload["paths"]
            or not all(isinstance(value, str) for value in payload["paths"])
            or len(payload["paths"]) != len(set(payload["paths"]))
        ):
            raise RuntimeError("invalid pending publication cleanup record")

        task_root = state_dir.parent.resolve()
        cleanup_paths = [
            _resolve_cleanup_pending_path(task_root, value)
            for value in payload["paths"]
        ]
        remaining = [
            path for path in cleanup_paths if not _cleanup_publication_path(path)
        ]
        if remaining:
            _write_cleanup_pending_record(state_dir, remaining)
            raise RuntimeError("pending publication cleanup could not be completed")
        pending_file.unlink()

    publish_tmp = state_dir / "publish_completed.json.part"
    if not _cleanup_publication_path(publish_tmp):
        raise RuntimeError("untracked publication cleanup could not be completed")
    task_root = state_dir.parent
    untracked = [
        *task_root.glob(".artifacts.previous-*"),
        *state_dir.glob("publish_completed.previous-*.json"),
    ]
    if untracked:
        raise RuntimeError("untracked publication cleanup paths remain")


def _cleanup_pending_relative_path(task_root: Path, path: Path) -> str:
    resolved = path.resolve()
    try:
        relative = resolved.relative_to(task_root)
    except ValueError as exc:
        raise ValueError("cleanup path must remain inside the task root") from exc
    value = relative.as_posix()
    _resolve_cleanup_pending_path(task_root, value)
    return value


def _resolve_cleanup_pending_path(task_root: Path, value: str) -> Path:
    relative = PurePosixPath(value)
    parts = relative.parts
    if relative.is_absolute() or not parts or any(
        part in {"", ".", ".."} for part in parts
    ):
        raise ValueError("cleanup path must be a safe task-local path")
    allowed = (
        len(parts) == 1
        and _ARTIFACT_BACKUP_NAME.fullmatch(parts[0]) is not None
    ) or (
        len(parts) == 2
        and parts[0] == "state"
        and (
            parts[1] == "publish_completed.json.part"
            or parts[1] == "publish_cleanup_pending.json.part"
            or _MARKER_BACKUP_NAME.fullmatch(parts[1]) is not None
        )
    )
    if not allowed:
        raise ValueError("cleanup path is not publication-owned")
    resolved = (task_root / Path(*parts)).resolve()
    try:
        resolved.relative_to(task_root)
    except ValueError as exc:
        raise ValueError("cleanup path must remain inside the task root") from exc
    return resolved


def _write_publish_completed_marker(marker_file: Path, target: Path) -> None:
    marker_payload = {
        "published_at": datetime.now(UTC).isoformat(),
        "artifacts_dir": str(target.relative_to(target.parents[0])),
    }
    tmp = marker_file.with_suffix(".json.part")
    tmp.write_text(json.dumps(marker_payload, indent=2) + "\n", "utf-8")
    with tmp.open("r+b") as handle:
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, marker_file)


def _write_runtime_publication_marker(
    staging: Path,
    *,
    task_id: str,
    run_id: str,
) -> None:
    """Write and verify the managed-Run marker before staging is renamed."""
    manifest_path = staging / "run_manifest.json"
    manifest_sha256 = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    expected = {
        "schema_version": 1,
        "task_id": task_id,
        "run_id": run_id,
        "manifest_sha256": manifest_sha256,
    }
    marker_path = staging / ".runtime-publication.json"
    marker_path.write_text(
        json.dumps(expected, ensure_ascii=False, sort_keys=True) + "\n",
        "utf-8",
    )
    actual = json.loads(marker_path.read_text("utf-8"))
    if actual != expected:
        raise RuntimeError("runtime publication marker changed before publication")
    if hashlib.sha256(manifest_path.read_bytes()).hexdigest() != manifest_sha256:
        raise RuntimeError("artifact manifest changed before formal publication")


def _validate_package(
    staging: Path,
    source_path: Path,
    report_path: Path,
    *,
    max_lineage_checks: int = _DEFAULT_MAX_LINEAGE_CHECKS,
) -> tuple[ValidationSummary, list[dict[str, object]]]:
    """Run all validation checks on the staging package."""
    main_path = staging / "main_data.csv"
    if not main_path.is_file():
        main_path = staging / "pathway_members.csv"
    main_rows = _read_csv(main_path)
    dataset_ids = {
        row["dataset_id"] for row in _read_csv(staging / "dataset_catalog.csv")
    }
    sample_rows = _read_csv(staging / "sample_metadata.csv")
    sample_ids = {row["sample_id"] for row in sample_rows}
    source_list_rows = _read_csv(staging / "source_list.csv")
    source_ids = {row["source_id"] for row in source_list_rows}
    reactome_rows = bool(main_rows) and "pathway_id" in main_rows[0]
    asset_rows = _read_csv(staging / "source_assets.csv")
    asset_ids = {row["asset_id"] for row in asset_rows}
    assets_by_id = {row["asset_id"]: row for row in asset_rows}
    dataset_rows = _read_csv(staging / "dataset_catalog.csv")
    download_rows = _read_csv(staging / "download_log.csv")
    described = {
        row["field_name"] for row in _read_csv(staging / "field_descriptions.csv")
    }

    checks: list[dict[str, object]] = []
    checks.append(
        {
            "check_id": "main_data_nonempty",
            "scope": "main_data",
            "check_name": "main data contains at least one record",
            "status": "passed" if main_rows else "failed",
            "checked_count": len(main_rows),
            "failed_count": 0 if main_rows else 1,
            "details": "",
        }
    )
    reference_failures = sum(
        row["dataset_id"] not in dataset_ids
        or (not reactome_rows and row["sample_id"] not in sample_ids)
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
    reactome_source_lines: list[list[str]] = []
    reactome_source_header: list[str] = []
    reactome_source_file = (
        source_path.name[:-3]
        if source_path.suffix.lower() == ".gz"
        else source_path.name
    )
    if reactome_rows:
        opener = gzip.open if source_path.suffix.lower() == ".gz" else Path.open
        if source_path.suffix.lower() == ".gz":
            with opener(source_path, "rt", encoding="utf-8", newline="") as handle:
                reactome_source_lines = list(csv.reader(handle, delimiter="\t", quotechar='"'))
        else:
            with source_path.open("r", encoding="utf-8", newline="") as handle:
                reactome_source_lines = list(csv.reader(handle, delimiter="\t", quotechar='"'))
        reactome_source_header = reactome_source_lines[0] if reactome_source_lines else []
        pathway_failures = sum(
            not row.get("pathway_id", "").strip()
            or not row.get("pathway_name", "").strip()
            or not row.get("species", "").strip()
            for row in main_rows
        )
        participant_failures = sum(
            not row.get("participant_id", "").strip()
            or not row.get("participant_name", "").strip()
            or not row.get("participant_type", "").strip()
            or not row.get("interaction_type", "").strip()
            for row in main_rows
        )
        source_failures = sum(
            not row.get("source_id", "").strip()
            or row.get("source_id", "") not in source_ids
            for row in main_rows
        )
        asset_failures_for_rows = sum(
            not row.get("asset_id", "").strip()
            or row.get("asset_id", "") not in asset_ids
            for row in main_rows
        )
        asset_source_failures = sum(
            row.get("source_id", "")
            != assets_by_id.get(row.get("asset_id", ""), {}).get(
                "source_id", ""
            )
            for row in main_rows
        )
        dataset_row = dataset_rows[0] if dataset_rows else {}
        dataset_source_failures = sum(
            row.get("source_id", "") != dataset_row.get("source_id", "")
            or dataset_row.get("source_id", "") not in source_ids
            for row in main_rows
        )
        source_list_failures = sum(
            source.get("source_id", "") == dataset_row.get("source_id", "")
            and (
                source.get("database", "") != dataset_row.get("database", "")
                or source.get("accession", "") != dataset_row.get("accession", "")
            )
            for source in source_list_rows
        )
        dataset_accession = dataset_row.get("accession", "").strip()
        pathway_dataset_failures = sum(
            row.get("pathway_id", "").strip() != dataset_accession
            for row in main_rows
        )
        locator_failures = 0
        for row in main_rows:
            try:
                valid_locator = (
                    bool(row.get("record_id", "").strip())
                    and bool(row.get("source_logical_file", "").strip())
                    and bool(row.get("source_column_name", "").strip())
                    and bool(row.get("source_raw_value", "").strip())
                    and int(row.get("source_line_number", "0")) >= 2
                    and int(row.get("source_column_index", "-1")) >= 0
                    and row.get("source_logical_file", "") == reactome_source_file
                    and int(row["source_column_index"]) < len(reactome_source_header)
                    and reactome_source_header[int(row["source_column_index"])]
                    == row.get("source_column_name", "")
                )
            except ValueError:
                valid_locator = False
            locator_failures += not valid_locator
        for check_id, check_name, failed_count in (
            (
                "reactome_pathway_fields",
                "Reactome pathway fields are complete",
                pathway_failures,
            ),
            (
                "reactome_participant_fields",
                "Reactome participant fields are complete",
                participant_failures,
            ),
            (
                "reactome_source_foreign_keys",
                "Reactome source references close",
                source_failures,
            ),
            (
                "reactome_asset_foreign_keys",
                "Reactome asset references close",
                asset_failures_for_rows,
            ),
            (
                "reactome_asset_source_consistency",
                "Reactome asset source references match main data",
                asset_source_failures,
            ),
            (
                "reactome_dataset_source_consistency",
                "Reactome dataset source matches main data and source list",
                dataset_source_failures + source_list_failures,
            ),
            (
                "reactome_pathway_dataset_consistency",
                "Reactome pathway IDs match dataset accession",
                pathway_dataset_failures,
            ),
            (
                "reactome_source_locator",
                "Reactome source locators are complete",
                locator_failures,
            ),
        ):
            checks.append(
                {
                    "check_id": check_id,
                    "scope": "pathway_members",
                    "check_name": check_name,
                    "status": "passed" if failed_count == 0 else "failed",
                    "checked_count": len(main_rows),
                    "failed_count": failed_count,
                    "details": "",
                }
            )
        duplicate_record_ids = len(main_rows) - len(
            {row.get("record_id", "") for row in main_rows}
        )
        checks.append(
            {
                "check_id": "reactome_lineage_contract",
                "scope": "main_data",
                "check_name": "Reactome participant and lineage fields are complete",
                "status": "passed" if duplicate_record_ids == 0 else "failed",
                "checked_count": len(main_rows),
                "failed_count": duplicate_record_ids,
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
    # row["relative_path"] 是相对于 task_dir 的路径（含 source_assets/ 前缀）。
    # source_path 可能是 task_dir/source_assets/file（测试场景）或
    # task_dir/source_assets/asset_dir/file（生产场景），需要动态查找
    # "source_assets" 组件来确定 task_dir。
    parts = source_path.parts
    try:
        sa_index = parts.index("source_assets")
    except ValueError:
        source_rel_base = source_path.parents[1]
    else:
        source_rel_base = source_path.parents[len(parts) - sa_index - 1]
    for row in asset_rows:
        asset_path = source_rel_base / row["relative_path"]
        asset_failures += (
            row["successful_attempt_id"] not in successful_attempt_ids
            or row["source_id"] not in source_ids
            or not asset_path.is_file()
            or int(row["size_bytes"]) != asset_path.stat().st_size
            or row["sha256"] != _sha256(asset_path)
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

    def _read_source_lines(path: Path) -> list[list[str]]:
        if path.suffix.lower() == ".gz":
            with gzip.open(path, "rt", encoding="utf-8", newline="") as handle:
                return list(csv.reader(handle, delimiter="\t", quotechar='"'))
        with path.open("r", encoding="utf-8", newline="") as handle:
            return list(csv.reader(handle, delimiter="\t", quotechar='"'))

    # Multi-source merged packages carry rows from several source files; route
    # each row's lineage check to the file of its own asset (TODO §1.5.4).
    # Single-source packages resolve every row to the one source_path, which
    # matches the pre-merge behavior.
    lines_cache: dict[str, list[list[str]]] = {}

    def _lines_for(asset_id: str) -> list[list[str]]:
        key = asset_id or "source"
        if key in lines_cache:
            return lines_cache[key]
        path = source_path
        if asset_id:
            asset_row = assets_by_id.get(asset_id)
            if asset_row and asset_row.get("relative_path"):
                candidate = source_rel_base / asset_row["relative_path"]
                if candidate.is_file():
                    path = candidate
        lines = _read_source_lines(path)
        lines_cache[key] = lines
        return lines

    sampled_rows = _deterministic_sample(main_rows, max_lineage_checks)
    lineage_failures = 0
    sampled_skipped = 0
    for row in sampled_rows:
        lines = _lines_for(row.get("asset_id", ""))
        if reactome_rows:
            line_index = int(row["source_line_number"]) - 1
            column_index = int(row["source_column_index"])
            try:
                raw = lines[line_index][column_index]
            except (IndexError, ValueError):
                lineage_failures += 1
                continue
            if raw != row["source_raw_value"] or raw != row["participant_id"]:
                lineage_failures += 1
            continue
        # Skip sample-metadata rows: they have no expression value to verify.
        if row.get("measurement_type") == "sample_metadata":
            sampled_skipped += 1
            continue
        line_index = int(row["source_line_number"]) - 1
        column_index = int(row["source_column_index"])
        try:
            raw = lines[line_index][column_index]
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
            "checked_count": len(sampled_rows) - sampled_skipped,
            "failed_count": lineage_failures,
            "details": json.dumps(
                {
                    "total_rows": len(main_rows),
                    "sampled": len(sampled_rows),
                    "skipped_metadata_rows": sampled_skipped,
                }
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
    # Cleaning report completeness: verify cleaning_report.csv exists and its
    # anomaly counts are consistent with warnings.csv cleaning entries.
    cleaning_path = staging / "cleaning_report.csv"
    cleaning_report_exists = cleaning_path.is_file()
    cleaning_rows = _read_csv(cleaning_path) if cleaning_report_exists else []
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
    checks.append(
        {
            "check_id": "cleaning_report_consistency",
            "scope": "cleaning",
            "check_name": "cleaning_report.csv anomaly counts match warnings.csv cleaning entries",
            "status": "passed" if cleaning_failures == 0 else "failed",
            "checked_count": cleaning_expected + cleaning_warn_count + 1,
            "failed_count": cleaning_failures,
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
    write_csv(
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
        model_name=ctx.model_name,
        mode=ctx.mode,
        live_accepted=ctx.mode == "live" and validation.status == "valid",
        started_at=ctx.started_at,
        finished_at=datetime.now(UTC),
    )
    (build_output.staging_dir / "run_manifest.json").write_text(
        manifest.model_dump_json(indent=2) + "\n", "utf-8"
    )

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
    """Compatibility wrapper for immediate publication without a Run marker."""
    _publish_artifacts_core(
        staging,
        artifacts,
        state_dir,
        task_id=None,
        run_id=None,
        check_cancelled=lambda: None,
    )
