"""T3 (Phase 7): pipeline stage_* events are mirrored by operation events.

Every stage_* emission site emits a paired operation_* event carrying
``operation_id`` / ``label`` / ``category`` (ARCHITECTURE §14.2), so the
frontend can render by operation identity while the legacy ``stage_*`` stream
stays intact for the compatibility period. No stage_* event is lost.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from app.domain.contracts import (
    AttemptStatus,
    OperationCompletedPayload,
    OperationFailedPayload,
    OperationProgressPayload,
    OperationStartedPayload,
    StageCompletedPayload,
    StageFailedPayload,
    StageProgressPayload,
    StageSkippedPayload,
    StageStartedPayload,
    TaskState,
    stage_operation_spec,
)
from app.pipeline.runner import PipelineRunner

FIXTURE_DIR = Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"

_OPERATION_PAYLOADS = (
    OperationStartedPayload,
    OperationProgressPayload,
    OperationCompletedPayload,
    OperationFailedPayload,
)


def _operation_events_by_attempt(
    events: list,
) -> dict[str, list[object]]:
    """Index operation events by the stage attempt they mirror."""

    by_attempt: dict[str, list[object]] = {}
    for envelope in events:
        if not envelope.stage_attempt_id:
            continue
        if isinstance(envelope.payload, _OPERATION_PAYLOADS):
            by_attempt.setdefault(envelope.stage_attempt_id, []).append(
                envelope.payload
            )
    return by_attempt


def test_fixture_run_mirrors_stage_events_with_operation_events(
    tmp_path: Path,
) -> None:
    """A full fixture run emits a paired operation event per stage_* event."""

    runner = PipelineRunner(
        task_id="task_operation_pairs",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    manifest = asyncio.run(runner.run())
    assert manifest.task_state is TaskState.COMPLETED

    events = runner.events
    # Compat period: the stage_* stream is still emitted exactly as before.
    started = [e for e in events if isinstance(e.payload, StageStartedPayload)]
    completed = [e for e in events if isinstance(e.payload, StageCompletedPayload)]
    assert len(started) == 5
    assert len(completed) == 5

    by_attempt = _operation_events_by_attempt(events)
    assert len(by_attempt) == 5  # one operation lifecycle per stage attempt
    completed_by_attempt = {
        e.stage_attempt_id: e.payload for e in completed
    }

    for envelope in started:
        stage = envelope.payload.stage
        operation = by_attempt[envelope.stage_attempt_id]
        starts = [
            p for p in operation if isinstance(p, OperationStartedPayload)
        ]
        finishes = [
            p for p in operation if isinstance(p, OperationCompletedPayload)
        ]
        assert len(starts) == 1
        assert len(finishes) == 1
        operation_id, label, category = stage_operation_spec(stage)
        assert starts[0].operation_id == operation_id
        assert starts[0].label == label
        assert starts[0].category == category
        assert starts[0].attempt == envelope.payload.attempt
        assert finishes[0].operation_id == operation_id
        assert finishes[0].label == label
        assert finishes[0].category == category
        assert finishes[0].status is AttemptStatus.SUCCEEDED
        assert (
            finishes[0].output_digest
            == completed_by_attempt[envelope.stage_attempt_id].output_digest
        )


def test_fixture_run_mirrors_stage_progress_events(tmp_path: Path) -> None:
    """Every stage_progress event is paired with an operation_progress event."""

    runner = PipelineRunner(
        task_id="task_operation_progress",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    manifest = asyncio.run(runner.run())
    assert manifest.task_state is TaskState.COMPLETED

    events = runner.events
    stage_progress = [
        e for e in events if isinstance(e.payload, StageProgressPayload)
    ]
    assert stage_progress  # the fixture emits mid-stage progress
    by_attempt = _operation_events_by_attempt(events)

    for envelope in stage_progress:
        stage = envelope.payload.stage
        operation = by_attempt[envelope.stage_attempt_id]
        mirrors = [
            p for p in operation if isinstance(p, OperationProgressPayload)
        ]
        assert mirrors, "stage_progress must be mirrored by operation_progress"
        operation_id, label, category = stage_operation_spec(stage)
        assert mirrors[-1].operation_id == operation_id
        assert mirrors[-1].label == label
        assert mirrors[-1].category == category
        assert mirrors[-1].kind == envelope.payload.kind
        assert mirrors[-1].current == envelope.payload.current
        assert mirrors[-1].total == envelope.payload.total


def test_reused_stage_emits_skipped_operation_pair(tmp_path: Path) -> None:
    """A digest-reused (skipped) stage is mirrored by a SKIPPED operation."""

    base_dir = tmp_path / "tasks"
    runner1 = PipelineRunner(
        task_id="task_operation_skip",
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    assert asyncio.run(runner1.run()).task_state is TaskState.COMPLETED

    # Second run: durable data stages skip; package stages rerun after publish
    # (see test_event_coverage.py::test_no_tool_events_for_skipped_stages).
    runner2 = PipelineRunner(
        task_id="task_operation_skip",
        base_dir=base_dir,
        fixture_dir=FIXTURE_DIR,
    )
    assert asyncio.run(runner2.run()).task_state is TaskState.COMPLETED

    events = runner2.events
    skipped = [e for e in events if isinstance(e.payload, StageSkippedPayload)]
    assert len(skipped) == 3  # discovery / acquisition / processing
    by_attempt = _operation_events_by_attempt(events)

    for envelope in skipped:
        operation = by_attempt[envelope.stage_attempt_id]
        skip_mirrors = [
            p
            for p in operation
            if isinstance(p, OperationCompletedPayload)
            and p.status is AttemptStatus.SKIPPED
        ]
        assert len(skip_mirrors) == 1
        skip = skip_mirrors[0]
        operation_id, label, category = stage_operation_spec(
            envelope.payload.stage
        )
        assert skip.operation_id == operation_id
        assert skip.label == label
        assert skip.category == category
        assert (
            skip.reused_operation_attempt_id
            == envelope.payload.reused_stage_attempt_id
        )


def test_failed_stage_mirrors_failed_operation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A failing stage emits StageFailedPayload AND OperationFailedPayload."""

    from app.pipeline import runner as runner_module

    def failing_acquisition(ctx, *_args, **_kwargs) -> None:
        del ctx
        raise RuntimeError("all acquisition candidates failed")

    monkeypatch.setattr(runner_module, "run_acquisition", failing_acquisition)
    runner = PipelineRunner(
        task_id="task_operation_fail",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    manifest = asyncio.run(runner.run())
    assert manifest.task_state is TaskState.FAILED

    events = runner.events
    failed = [e for e in events if isinstance(e.payload, StageFailedPayload)]
    assert len(failed) == 1
    envelope = failed[0]
    operation = _operation_events_by_attempt(events)[
        envelope.stage_attempt_id
    ]
    failure_mirrors = [
        p for p in operation if isinstance(p, OperationFailedPayload)
    ]
    assert len(failure_mirrors) == 1
    failure = failure_mirrors[0]
    operation_id, label, category = stage_operation_spec(envelope.payload.stage)
    assert failure.operation_id == operation_id
    assert failure.label == label
    assert failure.category == category
    assert failure.status is AttemptStatus.FAILED
    assert failure.error is not None
