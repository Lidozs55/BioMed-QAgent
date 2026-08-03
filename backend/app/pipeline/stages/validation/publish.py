"""Artifact publication: atomic rename of a validated staging package.

Writes ``state/publish_completed.json`` only after the rename succeeds, so
its presence is a reliable signal that ``artifacts/`` is fully populated
(TODO §8 line 276). Its absence means the publish did not complete (crash,
validation failure, cancellation, or in-flight).
"""
from __future__ import annotations

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

from app.pipeline.stages.base import StageContext
from app.pipeline.state import TaskLock

_ARTIFACT_BACKUP_NAME = re.compile(r"^\.artifacts\.previous-[0-9a-f]{32}$")
_MARKER_BACKUP_NAME = re.compile(
    r"^publish_completed\.previous-[0-9a-f]{32}\.json$"
)
_LOGGER = logging.getLogger(__name__)


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
    # Resolve _write_publish_completed_marker through the package attribute at
    # call time so tests monkeypatching
    # ``app.pipeline.stages.validation._write_publish_completed_marker`` still
    # take effect after the split into submodules.
    from app.pipeline.stages.validation import _write_publish_completed_marker

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
