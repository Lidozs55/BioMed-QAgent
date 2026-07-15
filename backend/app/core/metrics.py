"""Evaluation metrics and ablation tracking framework.

Provides ``MetricsTracker`` for per-task metric recording with stage-based
context managers, and ``export_ablation_report`` for comparing multiple runs.
"""

from __future__ import annotations

import json
import time
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC
from pathlib import Path

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Pydantic model
# ---------------------------------------------------------------------------


class AblationMetrics(BaseModel):
    """Per-task metrics snapshot for ablation studies.

    Records what data sources were used, how many files were downloaded,
    how many rows were processed, execution time, and any warnings/errors
    encountered during a single pipeline stage.
    """

    task_id: str
    pipeline_stage: str
    sources_count: int = 0
    files_downloaded: int = 0
    rows_processed: int = 0
    execution_time_sec: float = 0.0
    warnings: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)
    skill_names_used: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Internal stage record
# ---------------------------------------------------------------------------


@dataclass
class _Stage:
    """Internal per-stage accumulator."""

    name: str
    start_time: float = 0.0
    end_time: float | None = None
    downloads: int = 0
    rows: int = 0
    sources: int = 0
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    skills: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# MetricsTracker
# ---------------------------------------------------------------------------


class MetricsTracker:
    """Per-task metrics tracker with stage-based context managers.

    Usage::

        tracker = MetricsTracker(task_id="demo-001")

        with tracker.stage("search_pubmed"):
            # ... run PubMed search ...
            tracker.record_download("pubmed", file_count=1)
            tracker.record_processing(row_count=42)
            tracker.record_skill("pubmed")

        tracker.to_json()    # → dict
        tracker.save(path)   # → writes JSON file
    """

    def __init__(self, task_id: str = "default") -> None:
        self.task_id = task_id
        self._stages: dict[str, _Stage] = {}
        self._current_stage: str | None = None
        self._stage_stack: list[str] = []
        self._start_time: float = time.monotonic()

    # -- context manager ------------------------------------------------------

    @contextmanager
    def stage(self, name: str) -> Generator[None, None, None]:
        """Context manager that times a pipeline stage.

        Calls ``start_stage`` on enter and ``end_stage`` on exit.
        """
        self.start_stage(name)
        try:
            yield
        finally:
            self.end_stage(name)

    # -- lifecycle ------------------------------------------------------------

    def start_stage(self, name: str) -> None:
        """Begin timing *name* stage."""
        if name not in self._stages:
            self._stages[name] = _Stage(name=name)
        self._stages[name].start_time = time.monotonic()
        self._current_stage = name
        self._stage_stack.append(name)

    def end_stage(self, name: str) -> None:
        """Finish timing *name* stage."""
        now = time.monotonic()
        if name in self._stages:
            stage = self._stages[name]
            stage.end_time = now
        if self._current_stage == name:
            self._current_stage = None
        if self._stage_stack and self._stage_stack[-1] == name:
            self._stage_stack.pop()
        if self._stage_stack:
            self._current_stage = self._stage_stack[-1]

    # -- recording ------------------------------------------------------------

    def _current_or_global(self) -> _Stage:
        """Return the active stage or a lazily-created global accumulator."""
        if self._current_stage and self._current_stage in self._stages:
            return self._stages[self._current_stage]
        if "__global__" not in self._stages:
            self._stages["__global__"] = _Stage(name="__global__")
        return self._stages["__global__"]

    def record_download(self, source: str, file_count: int = 1) -> None:
        """Record *file_count* files downloaded from *source*."""
        self._current_or_global().downloads += file_count

    def record_processing(self, row_count: int) -> None:
        """Record *row_count* rows processed."""
        self._current_or_global().rows += row_count

    def record_source(self, count: int = 1) -> None:
        """Record *count* data sources used."""
        self._current_or_global().sources += count

    def record_skill(self, skill_name: str) -> None:
        """Record a skill name used during the current stage."""
        self._current_or_global().skills.append(skill_name)

    def add_warning(self, msg: str) -> None:
        """Append a warning message."""
        self._current_or_global().warnings.append(msg)

    def add_error(self, msg: str) -> None:
        """Append an error message."""
        self._current_or_global().errors.append(msg)

    # -- export ---------------------------------------------------------------

    def to_json(self) -> dict:
        """Export all collected metrics as a JSON-serializable dict."""
        stages_data: dict[str, dict] = {}
        total_sources = 0
        total_downloads = 0
        total_rows = 0
        total_warnings: list[str] = []
        total_errors: list[str] = []
        all_skills: set[str] = set()

        for name, stage in self._stages.items():
            if name == "__global__":
                continue  # internal accumulator, not a user-facing stage
            elapsed = (stage.end_time or time.monotonic()) - stage.start_time
            stages_data[name] = {
                "execution_time_sec": round(elapsed, 3),
                "sources_count": stage.sources,
                "files_downloaded": stage.downloads,
                "rows_processed": stage.rows,
                "warnings": list(stage.warnings),
                "errors": list(stage.errors),
                "skill_names_used": list(stage.skills),
            }
            total_sources += stage.sources
            total_downloads += stage.downloads
            total_rows += stage.rows
            total_warnings.extend(stage.warnings)
            total_errors.extend(stage.errors)
            all_skills.update(stage.skills)

        total_elapsed = time.monotonic() - self._start_time

        return {
            "task_id": self.task_id,
            "total_execution_time_sec": round(total_elapsed, 3),
            "total_sources_count": total_sources,
            "total_files_downloaded": total_downloads,
            "total_rows_processed": total_rows,
            "total_warnings": total_warnings,
            "total_errors": total_errors,
            "skill_names_used": sorted(all_skills),
            "stages": stages_data,
            "ablation_metrics": [
                AblationMetrics(
                    task_id=self.task_id,
                    pipeline_stage=name,
                    sources_count=s["sources_count"],
                    files_downloaded=s["files_downloaded"],
                    rows_processed=s["rows_processed"],
                    execution_time_sec=s["execution_time_sec"],
                    warnings=s["warnings"],
                    errors=s["errors"],
                    skill_names_used=s["skill_names_used"],
                ).model_dump()
                for name, s in stages_data.items()
            ],
        }

    def save(self, path: str | Path) -> Path:
        """Write metrics as a JSON file. Returns the written path."""
        out = Path(path)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps(self.to_json(), indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        return out


# ---------------------------------------------------------------------------
# Cross-run comparison
# ---------------------------------------------------------------------------


def export_ablation_report(
    trackers: list[MetricsTracker],
    output_path: str | Path,
) -> Path:
    """Compare multiple ``MetricsTracker`` instances and write a JSON report.

    Each tracker represents one pipeline run (e.g., different configs or
    queries). The report aggregates per-stage metrics across all runs for
    side-by-side comparison in ablation studies.

    Args:
        trackers: One ``MetricsTracker`` per pipeline run.
        output_path: Where to write the comparison JSON file.

    Returns:
        The path to the written report.
    """
    from datetime import datetime

    runs: list[dict] = [t.to_json() for t in trackers]

    # Collect all unique stage names across runs
    stage_names: set[str] = set()
    for run in runs:
        for name in run.get("stages", {}):
            stage_names.add(name)

    # Build per-stage comparison arrays
    stage_comparison: dict[str, dict] = {}
    for name in sorted(stage_names):
        times: list[float] = []
        dl: list[int] = []
        rows_list: list[int] = []
        for run in runs:
            s = run.get("stages", {}).get(name, {})
            times.append(s.get("execution_time_sec", 0.0))
            dl.append(s.get("files_downloaded", 0))
            rows_list.append(s.get("rows_processed", 0))
        stage_comparison[name] = {
            "execution_times_sec": times,
            "files_downloaded": dl,
            "rows_processed": rows_list,
        }

    report = {
        "report_type": "ablation_comparison",
        "generated_at": datetime.now(UTC).isoformat(),
        "run_count": len(runs),
        "runs": runs,
        "stage_comparison": stage_comparison,
    }

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(report, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    return out
