"""PipelineRunner state machine contract tests.

Covers P0 items: fixed-stage state machine, append-only StageAttempt,
input/parameter/output digests, stage-failure stops downstream, terminal
state guarantee, fixture mode, retry generates new attempt.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from app.domain.contracts import AttemptStatus, StageName, TaskState
from app.pipeline.runner import PipelineRunner

FIXTURE_DIR = Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"


def test_runner_executes_five_stages_in_order(tmp_path: Path) -> None:
    runner = PipelineRunner(
        task_id="task_order",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    manifest = asyncio.run(runner.run())

    assert manifest.task_state == TaskState.COMPLETED
    assert len(manifest.stage_attempt_ids) == 5

    attempts = runner.state.stage_attempts
    stages = [a.stage for a in attempts]
    assert stages == [
        StageName.DISCOVERY,
        StageName.ACQUISITION,
        StageName.PROCESSING,
        StageName.ARTIFACT_BUILD,
        StageName.VALIDATION,
    ]
    assert all(a.status == AttemptStatus.SUCCEEDED for a in attempts)


def test_runner_emits_input_parameter_output_digests(tmp_path: Path) -> None:
    runner = PipelineRunner(
        task_id="task_digest",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    asyncio.run(runner.run())

    for attempt in runner.state.stage_attempts:
        assert len(attempt.input_digest) == 64
        assert len(attempt.parameter_digest) == 64
        assert len(attempt.output_digest) == 64


def test_runner_stops_downstream_on_stage_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def failing_processing(ctx, source_asset, dataset_id, geo=None):
        raise ValueError("processing failed")

    monkeypatch.setattr(
        "app.pipeline.runner.run_processing", failing_processing
    )

    runner = PipelineRunner(
        task_id="task_fail",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    manifest = asyncio.run(runner.run())

    assert manifest.task_state == TaskState.FAILED
    attempts = runner.state.stage_attempts
    assert len(attempts) == 3
    assert attempts[0].stage == StageName.DISCOVERY
    assert attempts[0].status == AttemptStatus.SUCCEEDED
    assert attempts[1].stage == StageName.ACQUISITION
    assert attempts[1].status == AttemptStatus.SUCCEEDED
    assert attempts[2].stage == StageName.PROCESSING
    assert attempts[2].status == AttemptStatus.FAILED
    assert attempts[2].error is not None
    assert "processing failed" in attempts[2].error.message

    executed_stages = {a.stage for a in attempts}
    assert StageName.ARTIFACT_BUILD not in executed_stages
    assert StageName.VALIDATION not in executed_stages


def test_runner_guarantees_terminal_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner_ok = PipelineRunner(
        task_id="task_ok",
        base_dir=tmp_path / "tasks_ok",
        fixture_dir=FIXTURE_DIR,
    )
    manifest_ok = asyncio.run(runner_ok.run())
    assert manifest_ok.task_state == TaskState.COMPLETED

    def failing_discovery(ctx):
        raise RuntimeError("discovery crashed")

    monkeypatch.setattr(
        "app.pipeline.runner.run_discovery", failing_discovery
    )

    runner_fail = PipelineRunner(
        task_id="task_fail",
        base_dir=tmp_path / "tasks_fail",
        fixture_dir=FIXTURE_DIR,
    )
    manifest_fail = asyncio.run(runner_fail.run())
    assert manifest_fail.task_state == TaskState.FAILED


def test_runner_fixture_mode_completes_without_network(tmp_path: Path) -> None:
    runner = PipelineRunner(
        task_id="task_fixture",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    manifest = asyncio.run(runner.run())

    assert manifest.task_state == TaskState.COMPLETED
    assert manifest.validation.status == "valid"
    artifacts_dir = tmp_path / "tasks" / "task_fixture" / "artifacts"
    assert artifacts_dir.exists()
    assert len(list(artifacts_dir.iterdir())) > 0


def test_runner_appends_new_attempt_on_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.pipeline.runner as runner_module

    original_processing = runner_module.run_processing
    call_count = {"n": 0}

    def flaky_processing(ctx, source_asset, dataset_id, geo=None):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise ValueError("first attempt fails")
        return original_processing(ctx, source_asset, dataset_id)

    monkeypatch.setattr(runner_module, "run_processing", flaky_processing)

    base_dir = tmp_path / "tasks"
    runner1 = PipelineRunner(
        task_id="task_retry",
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    manifest1 = asyncio.run(runner1.run())
    assert manifest1.task_state == TaskState.FAILED

    failed_processing = [
        a for a in runner1.state.stage_attempts
        if a.stage == StageName.PROCESSING
    ]
    assert len(failed_processing) == 1
    assert failed_processing[0].status == AttemptStatus.FAILED
    first_attempt_id = failed_processing[0].stage_attempt_id

    runner2 = PipelineRunner(
        task_id="task_retry",
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    manifest2 = asyncio.run(runner2.run())
    assert manifest2.task_state == TaskState.COMPLETED

    all_processing = [
        a for a in runner2.state.stage_attempts
        if a.stage == StageName.PROCESSING
    ]
    assert len(all_processing) == 2
    assert all_processing[0].status == AttemptStatus.FAILED
    assert all_processing[1].status == AttemptStatus.SUCCEEDED
    assert all_processing[1].stage_attempt_id != first_attempt_id
