"""PipelineRunner idempotent recovery contract tests.

Covers P0 items: digest-matched output reuse, process-restart recovery
from last successful stage, independent skipped status identifier.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

from app.domain.contracts import AttemptStatus, StageName, TaskState
from app.pipeline.runner import PipelineRunner

FIXTURE_DIR = Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"


def test_runner_reuses_output_when_digest_matches(tmp_path: Path) -> None:
    base_dir = tmp_path / "tasks"

    runner1 = PipelineRunner(
        task_id="task_reuse",
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    manifest1 = asyncio.run(runner1.run())
    assert manifest1.task_state == TaskState.COMPLETED

    runner2 = PipelineRunner(
        task_id="task_reuse",
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    manifest2 = asyncio.run(runner2.run())
    assert manifest2.task_state == TaskState.COMPLETED

    skipped = [
        a for a in runner2.state.stage_attempts
        if a.status == AttemptStatus.SKIPPED
    ]
    assert len(skipped) == 5

    # Second run must not produce new SUCCEEDED attempts — only SKIPPED.
    # Total attempts = 5 (first run SUCCEEDED) + 5 (second run SKIPPED).
    event_types = [e.payload.type for e in runner2.events]
    assert "stage_completed" not in event_types


def test_runner_recovers_from_last_successful_stage(tmp_path: Path) -> None:
    base_dir = tmp_path / "tasks"

    runner1 = PipelineRunner(
        task_id="task_recover",
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    asyncio.run(runner1.run())

    runner2 = PipelineRunner(
        task_id="task_recover",
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    manifest2 = asyncio.run(runner2.run())

    assert manifest2.task_state == TaskState.COMPLETED

    event_types = [e.payload.type for e in runner2.events]
    assert "task_recovered" in event_types


def test_runner_skipped_status_independent(tmp_path: Path) -> None:
    base_dir = tmp_path / "tasks"

    runner1 = PipelineRunner(
        task_id="task_skip",
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    asyncio.run(runner1.run())

    runner2 = PipelineRunner(
        task_id="task_skip",
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    asyncio.run(runner2.run())

    skipped = [
        a for a in runner2.state.stage_attempts
        if a.status == AttemptStatus.SKIPPED
    ]
    succeeded_first = [
        a for a in runner1.state.stage_attempts
        if a.status == AttemptStatus.SUCCEEDED
    ]

    assert len(skipped) == 5
    assert len(succeeded_first) == 5

    for skip, succ in zip(skipped, succeeded_first, strict=True):
        assert skip.input_digest == succ.input_digest
        assert skip.parameter_digest == succ.parameter_digest
        assert skip.stage_attempt_id != succ.stage_attempt_id

    skipped_event = runner2.events
    skipped_payloads = [
        e for e in skipped_event if e.payload.type == "stage_skipped"
    ]
    assert len(skipped_payloads) == 5
