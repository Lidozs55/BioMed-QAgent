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


def create_task_workdir(task_id: str, base_dir: str | None = None) -> TaskWorkDir:
    """Create the approved isolated directory structure for one task."""

    safe_task_id = _validate_id(task_id, "task_id")
    base = (
        Path(base_dir) if base_dir else Path(settings.output_dir) / "tasks"
    ).resolve()
    root = base / safe_task_id

    paths: dict[str, Path] = {}
    for subdir in _SUBDIRS:
        path = root / subdir
        path.mkdir(parents=True, exist_ok=True)
        paths[subdir] = path

    return TaskWorkDir(root=root, **paths)
