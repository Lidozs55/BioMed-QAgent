"""Tests for pipeline event coverage — tool_called, tool_completed, warning events.

Covers §11 line 341: 事件覆盖创建、计划、阶段成功/失败/跳过、工具、警告、取消、恢复、Artifact 和终态.
"""
from __future__ import annotations

import asyncio
import csv
from datetime import UTC, datetime
from pathlib import Path

import pytest
from app.domain.contracts import (
    PipelineEventType,
    StageName,
    TaskState,
    WarningSeverity,
)
from app.pipeline.runner import PipelineRunner

FIXTURE_DIR = Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"


def _event_types(runner: PipelineRunner) -> list[str]:
    """Extract the type strings from all emitted events."""
    return [e.type.value for e in runner.events]


def test_pipeline_emits_tool_called_and_tool_completed_for_each_stage(
    tmp_path: Path,
) -> None:
    """Each non-skipped stage emits tool_called before and tool_completed after."""
    runner = PipelineRunner(
        task_id="task_tool_events",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    manifest = asyncio.run(runner.run())

    assert manifest.task_state == TaskState.COMPLETED

    types = _event_types(runner)
    tool_called_count = types.count(PipelineEventType.TOOL_CALLED.value)
    tool_completed_count = types.count(PipelineEventType.TOOL_COMPLETED.value)

    # 5 stages, all executed (fresh run, no skips)
    assert tool_called_count == 5
    assert tool_completed_count == 5

    # Verify tool_name pattern and ordering: each tool_called precedes its
    # tool_completed, and tool_called comes after stage_started.
    stage_started_indices = [
        i for i, t in enumerate(types) if t == PipelineEventType.STAGE_STARTED.value
    ]
    tool_called_indices = [
        i for i, t in enumerate(types) if t == PipelineEventType.TOOL_CALLED.value
    ]
    tool_completed_indices = [
        i for i, t in enumerate(types) if t == PipelineEventType.TOOL_COMPLETED.value
    ]

    for i in range(5):
        assert stage_started_indices[i] < tool_called_indices[i]
        assert tool_called_indices[i] < tool_completed_indices[i]


def test_tool_events_carry_correct_digests(tmp_path: Path) -> None:
    """tool_called carries arguments_digest (parameter_digest),
    tool_completed carries output_digest matching the stage result."""
    runner = PipelineRunner(
        task_id="task_tool_digests",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    asyncio.run(runner.run())

    tool_called_events = [
        e for e in runner.events
        if e.type == PipelineEventType.TOOL_CALLED
    ]
    tool_completed_events = [
        e for e in runner.events
        if e.type == PipelineEventType.TOOL_COMPLETED
    ]

    # Each tool_called has a 64-char hex arguments_digest
    for event in tool_called_events:
        payload = event.payload
        assert len(payload.arguments_digest) == 64
        assert payload.tool_name.startswith("run_")

    # Each tool_completed has a 64-char hex output_digest
    for event in tool_completed_events:
        payload = event.payload
        assert len(payload.output_digest) == 64
        assert payload.tool_name.startswith("run_")

    # tool_called and tool_completed for the same stage have matching tool_name
    called_names = [e.payload.tool_name for e in tool_called_events]
    completed_names = [e.payload.tool_name for e in tool_completed_events]
    assert called_names == completed_names

    # Verify the output_digest from tool_completed matches the stage's
    # output_digest in stage_attempts
    for event in tool_completed_events:
        tool_name = event.payload.tool_name
        stage_value = tool_name.removeprefix("run_")
        stage = StageName(stage_value)
        attempt = next(
            a for a in runner.state.stage_attempts if a.stage == stage
        )
        assert event.payload.output_digest == attempt.output_digest


def test_no_tool_events_for_skipped_stages(tmp_path: Path) -> None:
    """Skipped stages (digest reuse) do not emit tool_called/tool_completed."""
    base_dir = tmp_path / "tasks"

    # First run — all stages execute
    runner1 = PipelineRunner(
        task_id="task_skip_tools",
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    asyncio.run(runner1.run())

    # Second run — all stages should be skipped (digests match)
    runner2 = PipelineRunner(
        task_id="task_skip_tools",
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    manifest2 = asyncio.run(runner2.run())

    assert manifest2.task_state == TaskState.COMPLETED

    types2 = _event_types(runner2)
    assert PipelineEventType.TOOL_CALLED.value not in types2
    assert PipelineEventType.TOOL_COMPLETED.value not in types2


def test_no_warning_events_when_warnings_csv_is_empty(tmp_path: Path) -> None:
    """Fixture mode produces zero warnings — no WarningPayload events."""
    runner = PipelineRunner(
        task_id="task_no_warnings",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    asyncio.run(runner.run())

    types = _event_types(runner)
    assert PipelineEventType.WARNING.value not in types


def test_warning_events_emitted_when_warnings_csv_has_rows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When warnings.csv contains rows, the pipeline emits WarningPayload per row."""
    runner = PipelineRunner(
        task_id="task_with_warnings",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )

    # Patch run_artifact_build to inject warning rows into warnings.csv
    original_build = runner._execute_stage

    def patched_execute(stage, stage_outputs, stage_attempt_id):
        result = original_build(stage, stage_outputs, stage_attempt_id)
        if stage == StageName.ARTIFACT_BUILD:
            staging_dir = result.output.staging_dir
            warnings_csv = staging_dir / "warnings.csv"
            warning_rows = [
                {
                    "warning_id": "warn_001",
                    "severity": "warning",
                    "stage": "processing",
                    "code": "MISSING_VALUE",
                    "message": "3 missing values imputed",
                    "source_id": "src_geo_gse178352",
                    "asset_id": "asset_001",
                    "record_id": "row_42",
                    "created_at": datetime.now(UTC).isoformat(),
                },
                {
                    "warning_id": "warn_002",
                    "severity": "info",
                    "stage": "processing",
                    "code": "TYPE_COERCION",
                    "message": "2 values coerced to float",
                    "source_id": None,
                    "asset_id": None,
                    "record_id": None,
                    "created_at": datetime.now(UTC).isoformat(),
                },
            ]
            columns = [
                "warning_id", "severity", "stage", "code", "message",
                "source_id", "asset_id", "record_id", "created_at",
            ]
            with warnings_csv.open("w", encoding="utf-8", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=columns)
                writer.writeheader()
                writer.writerows(warning_rows)
            # Recompute output_digest since staging content changed
            import hashlib
            hasher = hashlib.sha256()
            for path in sorted(staging_dir.iterdir(), key=lambda p: p.name):
                if path.is_file():
                    rel = path.relative_to(staging_dir).as_posix()
                    file_hash = hashlib.sha256(path.read_bytes()).hexdigest()
                    hasher.update(rel.encode("utf-8"))
                    hasher.update(b"\0")
                    hasher.update(file_hash.encode("utf-8"))
                    hasher.update(b"\0")
            result.output_digest = hasher.hexdigest()
        return result

    monkeypatch.setattr(runner, "_execute_stage", patched_execute)

    asyncio.run(runner.run())

    warning_events = [
        e for e in runner.events if e.type == PipelineEventType.WARNING
    ]
    assert len(warning_events) == 2

    # Verify first warning
    w1 = warning_events[0].payload.warning
    assert w1.warning_id == "warn_001"
    assert w1.severity == WarningSeverity.WARNING
    assert w1.code == "MISSING_VALUE"
    assert w1.source_id == "src_geo_gse178352"

    # Verify second warning
    w2 = warning_events[1].payload.warning
    assert w2.warning_id == "warn_002"
    assert w2.severity == WarningSeverity.INFO
    assert w2.code == "TYPE_COERCION"
    assert w2.source_id is None
