"""Safe task-local directory layout for deterministic pipeline runs."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from app.config import settings

_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_SUBDIRS = (
    "source_assets",
    "download_tmp",
    "parsed",
    "normalized",
    "staging",
    "artifacts",
    "state",
    "logs",
    "agent_results",
)


def _validate_id(value: str, field_name: str) -> str:
    if not _SAFE_ID.fullmatch(value):
        raise ValueError(f"{field_name} must be a safe path identifier")
    return value


def _safe_child(root: Path, relative: str) -> Path:
    if not relative:
        raise ValueError("path must not be blank")
    root_resolved = root.resolve()
    candidate = (root / relative).resolve()
    try:
        candidate.relative_to(root_resolved)
    except ValueError as exc:
        raise ValueError("path must remain inside its task directory") from exc
    return candidate


@dataclass(frozen=True)
class TaskWorkDir:
    """Immutable set of task paths; content files remain stage-owned."""

    root: Path
    source_assets: Path
    download_tmp: Path
    parsed: Path
    normalized: Path
    staging: Path
    artifacts: Path
    state: Path
    logs: Path
    agent_results: Path

    @property
    def raw(self) -> Path:
        """Deprecated compatibility alias for pre-pipeline acquisition Skills."""

        return self.source_assets

    def source_asset_file(self, filename: str) -> Path:
        return _safe_child(self.source_assets, filename)

    def raw_file(self, filename: str) -> Path:
        """Deprecated compatibility helper; use ``source_asset_file``."""

        return self.source_asset_file(filename)

    def download_temp_file(self, filename: str) -> Path:
        return _safe_child(self.download_tmp, filename)

    def artifact_file(self, filename: str) -> Path:
        return _safe_child(self.artifacts, filename)

    def agent_staging_file(self, relative: str) -> Path:
        root = _safe_child(self.staging, "agent")
        root.mkdir(parents=True, exist_ok=True)
        return _safe_child(root, relative)

    def staging_run(self, run_id: str) -> Path:
        run_path = _safe_child(self.staging, _validate_id(run_id, "run_id"))
        run_path.mkdir(parents=True, exist_ok=True)
        return run_path


def resolve_task_local_file(
    workdir: TaskWorkDir,
    value: str | Path,
) -> Path:
    """Resolve an existing file without permitting task-root escape."""
    root = workdir.root.resolve(strict=True)
    requested = Path(value)
    candidate = requested if requested.is_absolute() else root / requested
    resolved = candidate.resolve(strict=False)
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise ValueError("source path must remain inside the task work directory") from exc
    if not resolved.is_file():
        raise FileNotFoundError(resolved)
    return resolved


def create_task_workdir(
    task_id: str,
    base_dir: str | None = None,
    *,
    root_dir: str | Path | None = None,
) -> TaskWorkDir:
    """Create the approved directory structure for a task or child staging root."""

    safe_task_id = _validate_id(task_id, "task_id")
    if root_dir is None:
        base = (
            Path(base_dir) if base_dir else Path(settings.output_dir) / "tasks"
        ).resolve()
        root = base / safe_task_id
    else:
        root = Path(root_dir).absolute()
        if root.exists() and root.is_symlink():
            raise ValueError("work directory root must not be a symlink")

    paths: dict[str, Path] = {}
    root.mkdir(parents=True, exist_ok=True)
    root = root.resolve(strict=True)
    for subdir in _SUBDIRS:
        path = root / subdir
        path.mkdir(parents=True, exist_ok=True)
        paths[subdir] = path

    return TaskWorkDir(root=root, **paths)
