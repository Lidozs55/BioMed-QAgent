"""Tests for TODO §1.7 — pipeline observability.

Covers two P0 items:
1. Structured JSON logging on ``logging.getLogger("app.pipeline")`` for
   stage_started / stage_completed / artifact_produced / validation_failed.
2. ``MetricsTracker`` integration — initialized in PipelineRunner, stage
   timing recorded, metrics saved to ``workdir/logs/metrics.json``.
"""
from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path

from app.domain.contracts import PipelineEventType
from app.pipeline.runner import PipelineRunner

FIXTURE_DIR = Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"

# Event types that TODO §1.7 requires to be covered by structured logs.
_REQUIRED_LOG_EVENT_TYPES = {
    PipelineEventType.STAGE_STARTED.value,
    PipelineEventType.STAGE_COMPLETED.value,
    PipelineEventType.ARTIFACT_PRODUCED.value,
}


def _capture_pipeline_log_records() -> tuple[list[logging.LogRecord], logging.Handler, int]:
    """Attach a capture handler to the ``app.pipeline`` logger.

    Returns ``(records, handler, original_level)`` — call
    ``logger.removeHandler(handler)`` and ``logger.setLevel(original_level)``
    after the run to detach and restore.
    """
    logger = logging.getLogger("app.pipeline")
    original_level = logger.level
    logger.setLevel(logging.INFO)  # ensure INFO records reach handlers
    records: list[logging.LogRecord] = []

    class _Capture(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            records.append(record)

    handler = _Capture()
    handler.setLevel(logging.INFO)
    logger.addHandler(handler)
    return records, handler, original_level


def test_publish_event_emits_structured_json_log(tmp_path: Path) -> None:
    """TODO §1.7 P0: ``_publish_event`` must emit a JSON log record via
    ``logging.getLogger("app.pipeline")`` for each event.

    The log record's message must be a JSON string containing at least
    ``type``, ``task_id``, ``sequence``, and ``timestamp`` fields. This
    covers stage_started / stage_completed / artifact_produced /
    validation_failed (and all other event types) because they all flow
    through ``_publish_event``.
    """
    runner = PipelineRunner(
        task_id="task_structured_log",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    records, handler, original_level = _capture_pipeline_log_records()
    try:
        asyncio.run(runner.run())
    finally:
        pipeline_logger = logging.getLogger("app.pipeline")
        pipeline_logger.removeHandler(handler)
        pipeline_logger.setLevel(original_level)

    # Parse every captured record's message as JSON.
    parsed = []
    for record in records:
        try:
            parsed.append(json.loads(record.getMessage()))
        except json.JSONDecodeError:
            continue  # non-JSON log lines (e.g. from other modules) are OK

    event_types_logged = {entry.get("type") for entry in parsed}
    missing = _REQUIRED_LOG_EVENT_TYPES - event_types_logged
    assert not missing, (
        f"structured log missing required event types: {sorted(missing)}; "
        f"got: {sorted(event_types_logged)}"
    )

    # Every parsed entry must carry the minimal audit fields.
    for entry in parsed:
        if entry.get("type") in _REQUIRED_LOG_EVENT_TYPES:
            assert "task_id" in entry
            assert "sequence" in entry
            assert "timestamp" in entry


def test_pipeline_run_writes_metrics_json(tmp_path: Path) -> None:
    """TODO §1.7 P0: PipelineRunner must initialize a MetricsTracker, record
    per-stage timing, and save to ``workdir/logs/metrics.json`` after run.

    The metrics file must contain timing for all 5 pipeline stages
    (discovery, acquisition, processing, artifact_build, validation).
    """
    runner = PipelineRunner(
        task_id="task_metrics",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    asyncio.run(runner.run())

    metrics_path = runner.workdir.logs / "metrics.json"
    assert metrics_path.exists(), (
        f"metrics.json not written to {metrics_path}"
    )

    data = json.loads(metrics_path.read_text(encoding="utf-8"))
    assert data["task_id"] == "task_metrics"
    assert "total_execution_time_sec" in data
    assert "stages" in data

    # All 5 stages must be present with non-negative execution time.
    expected_stages = {
        "discovery", "acquisition", "processing", "artifact_build", "validation",
    }
    actual_stages = set(data["stages"].keys())
    missing = expected_stages - actual_stages
    assert not missing, (
        f"metrics.json missing stage timings: {sorted(missing)}; "
        f"got: {sorted(actual_stages)}"
    )

    for stage_name, stage_data in data["stages"].items():
        assert "execution_time_sec" in stage_data, (
            f"stage {stage_name} missing execution_time_sec"
        )
        assert stage_data["execution_time_sec"] >= 0, (
            f"stage {stage_name} has negative execution_time_sec: "
            f"{stage_data['execution_time_sec']}"
        )
