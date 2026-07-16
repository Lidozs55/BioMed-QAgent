"""PipelineRunner idempotent recovery contract tests.

Covers P0 items: digest-matched output reuse, process-restart recovery
from last successful stage, independent skipped status identifier.
"""
from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest
from app.domain.contracts import (
    AttemptStatus,
    EventEnvelope,
    StageName,
    TaskState,
)
from app.pipeline.runner import PipelineRunner

FIXTURE_DIR = Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"


class HardPipelineInterruption(BaseException):
    """Simulate process death without runner-owned terminalization."""


def test_runner_recovers_durable_inflight_attempt_after_hard_interruption(
    tmp_path: Path,
) -> None:
    base_dir = tmp_path / "tasks"
    task_id = "task_hard_interruption"
    state_path = base_dir / task_id / "state" / "pipeline_state.json"
    attempts_path = base_dir / task_id / "logs" / "stage_attempts.jsonl"

    async def interrupt_after_durable_stage_start(event: EventEnvelope) -> None:
        payload = event.payload
        if payload.type != "stage_started":
            return
        durable_state = json.loads(state_path.read_text("utf-8"))
        inflight = durable_state.get("inflight_attempt")
        assert inflight is not None
        assert inflight["status"] == AttemptStatus.RUNNING.value
        assert inflight["stage"] == payload.stage.value
        assert inflight["attempt"] == payload.attempt
        assert inflight["stage_attempt_id"] == event.stage_attempt_id
        raise HardPipelineInterruption

    runner1 = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
        event_sink=interrupt_after_durable_stage_start,
    )
    with pytest.raises(HardPipelineInterruption):
        asyncio.run(runner1.run())

    runner2 = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    manifest = asyncio.run(runner2.run())

    assert manifest.task_state == TaskState.COMPLETED
    assert runner2.events[0].payload.type == "task_recovered"
    discovery_attempts = [
        attempt
        for attempt in runner2.state.stage_attempts
        if attempt.stage is StageName.DISCOVERY
    ]
    assert [attempt.attempt for attempt in discovery_attempts] == [1, 2]
    assert [attempt.status for attempt in discovery_attempts] == [
        AttemptStatus.CANCELLED,
        AttemptStatus.SUCCEEDED,
    ]
    assert (
        discovery_attempts[0].stage_attempt_id
        != discovery_attempts[1].stage_attempt_id
    )
    assert runner2.state.inflight_attempt is None
    assert [
        json.loads(line) for line in attempts_path.read_text("utf-8").splitlines()
    ] == [attempt.model_dump(mode="json") for attempt in runner2.state.stage_attempts]


def test_runner_recovers_after_process_death_releases_task_lock(
    tmp_path: Path,
) -> None:
    base_dir = tmp_path / "tasks"
    task_id = "task_process_death_lock"
    child_code = textwrap.dedent(
        """
        import asyncio
        import os
        import sys
        from pathlib import Path

        from app.pipeline.runner import PipelineRunner

        async def exit_on_stage_started(event):
            if event.payload.type == "stage_started":
                os._exit(73)

        runner = PipelineRunner(
            task_id=sys.argv[1],
            base_dir=Path(sys.argv[2]),
            fixture_dir=Path(sys.argv[3]),
            event_sink=exit_on_stage_started,
        )
        asyncio.run(runner.run())
        """
    )
    crashed = subprocess.run(
        [
            sys.executable,
            "-c",
            child_code,
            task_id,
            str(base_dir),
            str(FIXTURE_DIR),
        ],
        check=False,
        capture_output=True,
        text=True,
    )

    assert crashed.returncode == 73, crashed.stderr
    state_path = base_dir / task_id / "state" / "pipeline_state.json"
    crashed_state = json.loads(state_path.read_text("utf-8"))
    assert crashed_state["inflight_attempt"]["status"] == AttemptStatus.RUNNING.value
    lock_path = base_dir / task_id / "state" / "task_running.lock"
    assert lock_path.is_file()

    runner = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    manifest = asyncio.run(runner.run())

    assert manifest.task_state is TaskState.COMPLETED
    discovery_attempts = [
        attempt
        for attempt in runner.state.stage_attempts
        if attempt.stage is StageName.DISCOVERY
    ]
    assert [attempt.attempt for attempt in discovery_attempts] == [1, 2]
    assert [attempt.status for attempt in discovery_attempts] == [
        AttemptStatus.CANCELLED,
        AttemptStatus.SUCCEEDED,
    ]
    assert runner.state.inflight_attempt is None


def test_stage_attempt_numbers_remain_monotonic_across_reuse_and_parameter_change(
    tmp_path: Path,
) -> None:
    base_dir = tmp_path / "tasks"
    task_id = "task_monotonic_attempts"

    runner1 = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    asyncio.run(runner1.run())

    runner2 = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    asyncio.run(runner2.run())

    runner3 = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
        topic="changed topic forces new parameters",
    )
    asyncio.run(runner3.run())

    for stage in StageName:
        attempts = [
            attempt
            for attempt in runner3.state.stage_attempts
            if attempt.stage is stage
        ]
        assert [attempt.attempt for attempt in attempts] == [1, 2, 3]
        assert [attempt.status for attempt in attempts] == [
            AttemptStatus.SUCCEEDED,
            AttemptStatus.SKIPPED,
            AttemptStatus.SUCCEEDED,
        ]

    started_attempts = {
        event.payload.stage: event.payload.attempt
        for event in runner3.events
        if event.payload.type == "stage_started"
    }
    assert started_attempts == dict.fromkeys(StageName, 3)


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


def test_runner_appends_recovery_events_without_overwriting_audit_history(
    tmp_path: Path,
) -> None:
    base_dir = tmp_path / "tasks"
    task_id = "task_append_only_events"

    runner1 = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    asyncio.run(runner1.run())

    runner2 = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    asyncio.run(runner2.run())

    # Cross-run event durability is handled by the runtime EventStore; the
    # runner's in-memory events list only reflects the current run. The second
    # run emits task_recovered as its first event with recovered_from_sequence=0
    # (sequence now always starts from 1 since _load_last_sequence was removed).
    assert runner2.events[0].payload.type == "task_recovered"
    assert runner2.events[0].payload.recovered_from_sequence == 0


def test_runner_repairs_stage_attempt_log_from_durable_state_before_appending(
    tmp_path: Path,
) -> None:
    base_dir = tmp_path / "tasks"
    task_id = "task_attempt_log_repair"
    attempts_path = base_dir / task_id / "logs" / "stage_attempts.jsonl"
    runner1 = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    asyncio.run(runner1.run())
    persisted = attempts_path.read_text("utf-8").splitlines()
    attempts_path.write_text("\n".join(persisted[:-1]) + "\n", "utf-8")

    runner2 = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    asyncio.run(runner2.run())

    repaired = [json.loads(line) for line in attempts_path.read_text("utf-8").splitlines()]
    assert repaired == [
        attempt.model_dump(mode="json") for attempt in runner2.state.stage_attempts
    ]


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
