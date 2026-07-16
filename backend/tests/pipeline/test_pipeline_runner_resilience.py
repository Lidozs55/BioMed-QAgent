"""PipelineRunner resilience contract tests.

Covers P0 items: cancel requested -> cancelled, per-stage timeout,
total task timeout, no silent fallback to mock on failure.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import threading
import time
from pathlib import Path

import pytest
from app.domain.contracts import AttemptStatus, StageName, TaskState
from app.pipeline.runner import (
    DEFAULT_STAGE_TIMEOUTS,
    PipelineEventSinkError,
    PipelineRunner,
)
from app.pipeline.stages import PipelineCancelledError

FIXTURE_DIR = Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"


def test_runner_cancels_when_requested_before_stage(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.pipeline.runner as runner_module

    original_acquisition = runner_module.run_acquisition
    runner_holder: dict[str, PipelineRunner | None] = {"runner": None}

    def cancel_after_acquisition(ctx, retrieved_at):
        result = original_acquisition(ctx, retrieved_at)
        runner = runner_holder["runner"]
        assert runner is not None
        runner.request_cancel("test cancel")
        return result

    monkeypatch.setattr(runner_module, "run_acquisition", cancel_after_acquisition)

    runner = PipelineRunner(
        task_id="task_cancel",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    runner_holder["runner"] = runner
    manifest = asyncio.run(runner.run())

    assert manifest.task_state == TaskState.CANCELLED

    attempts = runner.state.stage_attempts
    stages = [a.stage for a in attempts]
    assert StageName.DISCOVERY in stages
    assert StageName.ACQUISITION in stages
    assert StageName.PROCESSING not in stages
    assert StageName.ARTIFACT_BUILD not in stages
    assert StageName.VALIDATION not in stages

    event_types = [e.payload.type for e in runner.events]
    assert "task_cancelled" in event_types


def test_runner_terminalizes_inflight_attempt_on_stage_cancellation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def cancelling_discovery(ctx):
        raise PipelineCancelledError("cancelled inside discovery")

    monkeypatch.setattr("app.pipeline.runner.run_discovery", cancelling_discovery)
    runner = PipelineRunner(
        task_id="task_cancel_inflight",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )

    manifest = asyncio.run(runner.run())

    assert manifest.task_state == TaskState.CANCELLED
    assert len(runner.state.stage_attempts) == 1
    cancelled = runner.state.stage_attempts[0]
    assert cancelled.stage is StageName.DISCOVERY
    assert cancelled.status is AttemptStatus.CANCELLED
    assert cancelled.attempt == 1
    started = next(
        event for event in runner.events if event.payload.type == "stage_started"
    )
    assert cancelled.stage_attempt_id == started.stage_attempt_id
    assert cancelled.attempt == started.payload.attempt
    assert runner.state.inflight_attempt is None
    attempts_path = runner.workdir.logs / "stage_attempts.jsonl"
    assert [
        json.loads(line) for line in attempts_path.read_text("utf-8").splitlines()
    ] == [attempt.model_dump(mode="json") for attempt in runner.state.stage_attempts]


def test_runner_terminalizes_inflight_attempt_on_stage_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def failing_discovery(ctx):
        raise RuntimeError("discovery failed")

    monkeypatch.setattr("app.pipeline.runner.run_discovery", failing_discovery)
    runner = PipelineRunner(
        task_id="task_fail_inflight",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )

    manifest = asyncio.run(runner.run())

    assert manifest.task_state == TaskState.FAILED
    assert len(runner.state.stage_attempts) == 1
    failed = runner.state.stage_attempts[0]
    assert failed.stage is StageName.DISCOVERY
    assert failed.status is AttemptStatus.FAILED
    assert failed.attempt == 1
    started = next(
        event for event in runner.events if event.payload.type == "stage_started"
    )
    assert failed.stage_attempt_id == started.stage_attempt_id
    assert failed.attempt == started.payload.attempt
    assert runner.state.inflight_attempt is None
    attempts_path = runner.workdir.logs / "stage_attempts.jsonl"
    assert [
        json.loads(line) for line in attempts_path.read_text("utf-8").splitlines()
    ] == [attempt.model_dump(mode="json") for attempt in runner.state.stage_attempts]


def test_stage_failure_is_durable_before_stage_failed_event_is_awaited(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def failing_discovery(ctx):
        raise RuntimeError("discovery failed before event sink")

    async def fail_on_stage_failed(event) -> None:
        if event.payload.type == "stage_failed":
            raise OSError("runtime rejected stage_failed")

    monkeypatch.setattr("app.pipeline.runner.run_discovery", failing_discovery)
    runner = PipelineRunner(
        task_id="task_failed_event_sink",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
        event_sink=fail_on_stage_failed,
    )

    with pytest.raises(PipelineEventSinkError, match="runtime rejected stage_failed"):
        asyncio.run(runner.run())

    started = next(
        event for event in runner.events if event.payload.type == "stage_started"
    )
    state_path = runner.workdir.state / "pipeline_state.json"
    durable_state = json.loads(state_path.read_text("utf-8"))
    assert durable_state["inflight_attempt"] is None
    assert len(durable_state["stage_attempts"]) == 1
    failed = durable_state["stage_attempts"][0]
    assert failed["status"] == AttemptStatus.FAILED.value
    assert failed["stage_attempt_id"] == started.stage_attempt_id
    assert failed["attempt"] == started.payload.attempt


def test_runner_per_stage_timeout_marks_failed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def slow_discovery(ctx):
        time.sleep(0.3)

    monkeypatch.setattr("app.pipeline.runner.run_discovery", slow_discovery)

    runner = PipelineRunner(
        task_id="task_stage_timeout",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
        stage_timeouts={**DEFAULT_STAGE_TIMEOUTS, StageName.DISCOVERY: 0.05},
    )
    manifest = asyncio.run(runner.run())

    assert manifest.task_state == TaskState.FAILED

    failed = [
        a for a in runner.state.stage_attempts
        if a.status == AttemptStatus.FAILED
    ]
    assert len(failed) == 1
    assert failed[0].stage == StageName.DISCOVERY
    assert failed[0].error is not None
    assert "timeout" in failed[0].error.message.lower()


def test_runner_total_timeout_marks_failed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def slow_discovery(ctx):
        time.sleep(0.3)

    monkeypatch.setattr("app.pipeline.runner.run_discovery", slow_discovery)

    runner = PipelineRunner(
        task_id="task_total_timeout",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
        total_timeout=0.05,
    )
    manifest = asyncio.run(runner.run())

    assert manifest.task_state == TaskState.FAILED
    assert runner.state.inflight_attempt is None
    assert runner.state.stage_attempts
    assert all(
        attempt.status is not AttemptStatus.RUNNING
        for attempt in runner.state.stage_attempts
    )


def test_runner_no_silent_fallback_on_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def failing_validation(ctx, build_output, stage_attempts, stage_attempt_id):
        raise RuntimeError("validation failed")

    monkeypatch.setattr("app.pipeline.runner.run_validation", failing_validation)

    runner = PipelineRunner(
        task_id="task_no_fallback",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    manifest = asyncio.run(runner.run())

    assert manifest.task_state == TaskState.FAILED
    assert manifest.validation.status == "invalid"
    assert len(manifest.artifacts) == 0

    failed = [
        a for a in runner.state.stage_attempts
        if a.status == AttemptStatus.FAILED
    ]
    assert len(failed) == 1
    assert failed[0].stage == StageName.VALIDATION


def test_runner_cancellation_token_stops_before_atomic_publication(
    tmp_path: Path,
) -> None:
    task_id = "task_cancel_before_publish"
    task_root = tmp_path / "tasks" / task_id
    staged_manifest = (
        task_root / "staging" / "run_pinned_fixture" / "run_manifest.json"
    )

    class CancelAtPublication:
        def is_set(self) -> bool:
            return staged_manifest.is_file()

    runner = PipelineRunner(
        task_id=task_id,
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
        cancellation_requested=CancelAtPublication(),
    )
    manifest = asyncio.run(runner.run())

    assert manifest.task_state == TaskState.CANCELLED
    assert not (task_root / "artifacts" / "run_manifest.json").exists()
    assert not any(event.type == "artifact_produced" for event in runner.events)


def test_managed_runner_defers_formal_publication_until_runtime_commit(
    tmp_path: Path,
) -> None:
    task_id = "task_deferred_publication"
    run_id = "run_deferred_publication"
    task_root = tmp_path / "tasks" / task_id
    runner = PipelineRunner(
        task_id=task_id,
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
        defer_publication=True,
    )

    manifest = asyncio.run(runner.run())

    assert manifest.task_state == TaskState.COMPLETED
    assert not (task_root / "artifacts" / "run_manifest.json").exists()
    runner.publish(run_id)
    marker = json.loads(
        (task_root / "artifacts" / ".runtime-publication.json").read_text("utf-8")
    )
    assert marker == {
        "schema_version": 1,
        "task_id": task_id,
        "run_id": run_id,
        "manifest_sha256": hashlib.sha256(
            (task_root / "artifacts" / "run_manifest.json").read_bytes()
        ).hexdigest(),
    }


@pytest.mark.asyncio
async def test_stage_timeout_drains_worker_before_terminal_state(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    worker_exited = threading.Event()

    def slow_discovery(ctx):
        try:
            time.sleep(0.2)
        finally:
            worker_exited.set()

    monkeypatch.setattr("app.pipeline.runner.run_discovery", slow_discovery)
    runner = PipelineRunner(
        task_id="task_timeout_drain",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
        stage_timeouts={**DEFAULT_STAGE_TIMEOUTS, StageName.DISCOVERY: 0.01},
    )

    manifest = await runner.run()

    assert manifest.task_state == TaskState.FAILED
    assert worker_exited.is_set()
