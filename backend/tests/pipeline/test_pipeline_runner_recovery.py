"""PipelineRunner idempotent recovery contract tests.

Covers P0 items: digest-matched output reuse, process-restart recovery
from last successful stage, independent skipped status identifier.
"""
from __future__ import annotations

import asyncio
import json
import shutil
import threading
from pathlib import Path

import app.pipeline.runner as runner_module
import pytest
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


def test_runner_does_not_pair_old_attempt_with_current_different_output(
    tmp_path: Path,
) -> None:
    base_dir = tmp_path / "tasks"
    task_id = "task_reuse_a_b_a"

    first_a = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
        topic="topic A",
    )
    assert asyncio.run(first_a.run()).task_state is TaskState.COMPLETED

    run_b = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
        topic="topic B",
    )
    assert asyncio.run(run_b.run()).task_state is TaskState.COMPLETED

    second_a = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
        topic="topic A",
    )
    manifest = asyncio.run(second_a.run())

    assert manifest.task_state is TaskState.COMPLETED
    assert manifest.specification is not None
    assert manifest.specification.topic == "topic A"
    discovery_attempts = [
        attempt
        for attempt in second_a.state.stage_attempts
        if attempt.stage is StageName.DISCOVERY
    ]
    assert discovery_attempts[-1].status is AttemptStatus.SUCCEEDED


def test_runner_reexecutes_stage_when_persisted_output_digest_does_not_match(
    tmp_path: Path,
) -> None:
    base_dir = tmp_path / "tasks"
    task_a = "task_output_digest_a"
    task_b = "task_output_digest_b"

    runner_a = PipelineRunner(
        task_id=task_a,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
        topic="topic A",
    )
    assert asyncio.run(runner_a.run()).task_state is TaskState.COMPLETED
    runner_b = PipelineRunner(
        task_id=task_b,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
        topic="topic B",
    )
    assert asyncio.run(runner_b.run()).task_state is TaskState.COMPLETED

    shutil.copyfile(
        base_dir / task_b / "state" / "discovery_output.json",
        base_dir / task_a / "state" / "discovery_output.json",
    )

    recovered_a = PipelineRunner(
        task_id=task_a,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
        topic="topic A",
    )
    assert asyncio.run(recovered_a.run()).task_state is TaskState.COMPLETED
    discovery_attempts = [
        attempt
        for attempt in recovered_a.state.stage_attempts
        if attempt.stage is StageName.DISCOVERY
    ]
    assert discovery_attempts[-1].status is AttemptStatus.SUCCEEDED


def test_runner_reexecutes_stage_when_persisted_output_content_is_corrupt(
    tmp_path: Path,
) -> None:
    base_dir = tmp_path / "tasks"
    task_id = "task_output_content_corrupt"
    runner = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
        topic="topic A",
    )
    assert asyncio.run(runner.run()).task_state is TaskState.COMPLETED

    output_path = base_dir / task_id / "state" / "discovery_output.json"
    persisted = json.loads(output_path.read_text("utf-8"))
    persisted["output"]["specification"]["topic"] = "corrupt topic"
    output_path.write_text(json.dumps(persisted), "utf-8")

    recovered = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
        topic="topic A",
    )
    assert asyncio.run(recovered.run()).task_state is TaskState.COMPLETED
    discovery_attempts = [
        attempt
        for attempt in recovered.state.stage_attempts
        if attempt.stage is StageName.DISCOVERY
    ]
    assert discovery_attempts[-1].status is AttemptStatus.SUCCEEDED


def test_runner_reexecutes_stage_when_persisted_output_is_invalid_json(
    tmp_path: Path,
) -> None:
    base_dir = tmp_path / "tasks"
    task_id = "task_output_invalid_json"
    runner = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
        topic="topic A",
    )
    assert asyncio.run(runner.run()).task_state is TaskState.COMPLETED

    output_path = base_dir / task_id / "state" / "discovery_output.json"
    output_path.write_text('{"schema_version": 1,', "utf-8")

    recovered = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
        topic="topic A",
    )
    assert asyncio.run(recovered.run()).task_state is TaskState.COMPLETED
    discovery_attempts = [
        attempt
        for attempt in recovered.state.stage_attempts
        if attempt.stage is StageName.DISCOVERY
    ]
    assert discovery_attempts[-1].status is AttemptStatus.SUCCEEDED


def test_stage_attempt_numbers_increase_across_parameter_changes(
    tmp_path: Path,
) -> None:
    base_dir = tmp_path / "tasks"
    task_id = "task_monotonic_attempts"
    stage_started_attempts: list[int] = []
    latest_runner: PipelineRunner | None = None

    for topic in ("topic A", "topic B", "topic A"):
        latest_runner = PipelineRunner(
            task_id=task_id,
            base_dir=base_dir,
            fixture_dir=FIXTURE_DIR,
            topic=topic,
        )
        assert asyncio.run(latest_runner.run()).task_state is TaskState.COMPLETED
        discovery_started = next(
            event.payload
            for event in latest_runner.events
            if event.payload.type == "stage_started"
            and event.payload.stage is StageName.DISCOVERY
        )
        stage_started_attempts.append(discovery_started.attempt)

    assert latest_runner is not None
    discovery_attempts = [
        attempt.attempt
        for attempt in latest_runner.state.stage_attempts
        if attempt.stage is StageName.DISCOVERY
    ]
    assert discovery_attempts == [1, 2, 3]
    assert stage_started_attempts == [1, 2, 3]


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
    log_path = base_dir / task_id / "logs" / "events.jsonl"

    runner1 = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    asyncio.run(runner1.run())
    first_lines = log_path.read_text("utf-8").splitlines()

    runner2 = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    asyncio.run(runner2.run())
    combined_lines = log_path.read_text("utf-8").splitlines()
    combined = [json.loads(line) for line in combined_lines]

    assert combined_lines[: len(first_lines)] == first_lines
    assert len(combined_lines) == len(first_lines) + len(runner2.events)
    assert [event["sequence"] for event in combined] == list(
        range(1, len(combined) + 1)
    )
    assert runner2.events[0].payload.type == "task_recovered"
    assert runner2.events[0].payload.recovered_from_sequence == len(first_lines)


@pytest.mark.asyncio
async def test_runner_persists_events_before_nonterminal_interruption_and_recovers(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    base_dir = tmp_path / "tasks"
    task_id = "task_interrupted_event_audit"
    log_path = base_dir / task_id / "logs" / "events.jsonl"
    stage_entered = threading.Event()
    release_stage = threading.Event()
    original_discovery = runner_module.run_discovery

    def controlled_discovery(ctx):
        stage_entered.set()
        release_stage.wait()
        return original_discovery(ctx)

    monkeypatch.setattr(runner_module, "run_discovery", controlled_discovery)
    streamed_events = []
    runner = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
        event_sink=streamed_events.append,
    )
    run_task = asyncio.create_task(runner.run())
    try:
        assert await asyncio.wait_for(
            asyncio.to_thread(stage_entered.wait, 1),
            timeout=2,
        )
        persisted_before_terminal = log_path.read_text("utf-8").splitlines()
        persisted_types = [
            json.loads(line)["type"] for line in persisted_before_terminal
        ]
        assert persisted_types == [
            "task_created",
            "plan_ready",
            "stage_started",
        ]
        assert [event.type for event in streamed_events] == persisted_types

        run_task.cancel()
    finally:
        release_stage.set()

    with pytest.raises(asyncio.CancelledError):
        await run_task

    interrupted_lines = log_path.read_text("utf-8").splitlines()
    assert interrupted_lines == persisted_before_terminal

    monkeypatch.setattr(runner_module, "run_discovery", original_discovery)
    recovered = PipelineRunner(
        task_id=task_id,
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    assert (await recovered.run()).task_state is TaskState.COMPLETED

    combined_lines = log_path.read_text("utf-8").splitlines()
    combined = [json.loads(line) for line in combined_lines]
    assert combined_lines[: len(interrupted_lines)] == interrupted_lines
    assert len(combined_lines) == len(interrupted_lines) + len(recovered.events)
    assert [event["sequence"] for event in combined] == list(
        range(1, len(combined) + 1)
    )


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
