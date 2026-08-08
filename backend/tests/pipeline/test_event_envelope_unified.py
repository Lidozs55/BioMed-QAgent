"""Integration tests for the unified WebSocket Event Envelope (TODO.md §11).

Covers:
    1. EventEnvelope carries schema_version, event_id, sequence, timestamp.
    2. run_streamed() yields EventEnvelope objects in order with persist-then-push.
    3-4. (Legacy REST/WS envelope) — superseded by tests/api/test_rest_control.py
         and tests/api/test_websocket_replay.py (durable event API).
    5. Recovery emits a task_recovered event (verified via runner.events).
    6. Stage failure preserves prior events + failure event (runner.events).
    7. Cancellation preserves prior events + cancel event (runner.events).

Event persistence is handled by the runtime EventStore (authoritative). These
tests assert against the in-memory ``runner.events`` list instead of the
removed ``logs/events.jsonl`` file.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from app.domain.contracts import (
    AttemptStatus,
    EventEnvelope,
    PipelineEventType,
    TaskState,
)
from app.pipeline.runner import PipelineRunner

FIXTURE_DIR = (
    Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"
)


# ---------------------------------------------------------------------------
# Scenario 1: EventEnvelope schema_version + canonical fields
# ---------------------------------------------------------------------------


def test_event_envelope_carries_schema_version_and_canonical_fields(
    tmp_path: Path,
) -> None:
    """Every emitted event must carry schema_version + the §11 field set."""
    runner = PipelineRunner(
        task_id="task_envelope_fields",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    asyncio.run(runner.run())

    events = runner.events
    assert len(events) > 0

    for envelope in events:
        # T3 (Phase 7): stage_* events stay schema 1.0; their operation_*
        # mirrors are run-scoped RuntimeEventType events and therefore carry
        # schema_version 2.0 + run_id (ARCHITECTURE §14.2).
        assert envelope.schema_version in {"1.0", "2.0"}
        assert envelope.task_id == "task_envelope_fields"
        assert envelope.event_id
        assert envelope.type
        assert envelope.sequence >= 1
        assert envelope.timestamp
        assert envelope.payload is not None
        # payload.type must match the envelope type.
        assert envelope.payload.type == envelope.type
        # Validate the envelope round-trips through the typed contract.
        assert EventEnvelope.model_validate(envelope.model_dump()) == envelope


# ---------------------------------------------------------------------------
# Scenario 2: run_streamed yields typed EventEnvelope in sequence order
# ---------------------------------------------------------------------------


def test_run_streamed_yields_typed_envelopes_in_sequence_order(
    tmp_path: Path,
) -> None:
    """run_streamed() must yield EventEnvelope objects with contiguous sequence."""
    runner = PipelineRunner(
        task_id="task_streamed",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )

    async def _collect() -> list[EventEnvelope]:
        return [event async for event in runner.run_streamed()]

    events = asyncio.run(_collect())
    assert runner.manifest is not None
    assert runner.manifest.task_state == TaskState.COMPLETED
    assert len(events) >= 7  # task_created + plan_ready + 5×stage pairs + terminal

    sequences = [e.sequence for e in events]
    assert sequences == list(range(1, len(events) + 1))
    assert all(isinstance(e, EventEnvelope) for e in events)
    assert events[0].type is PipelineEventType.TASK_CREATED
    assert events[-1].type in {PipelineEventType.TASK_COMPLETED, PipelineEventType.TASK_FAILED}


# ---------------------------------------------------------------------------
# Scenario 4 & 5 (legacy REST/WS envelope) — superseded by
# tests/api/test_rest_control.py and tests/api/test_websocket_replay.py
# which cover the durable event API (after_sequence + durable WS session).
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Scenario 3: Recovery emits task_recovered (verified via runner.events)
# ---------------------------------------------------------------------------


def test_recovery_appends_events_without_overwriting_prior_ones(
    tmp_path: Path, monkeypatch
) -> None:
    """A recovery run must emit a task_recovered event starting at sequence 1.

    Cross-run event durability is handled by the runtime EventStore; the
    runner's in-memory ``events`` list only reflects the current run. We
    therefore assert that the second run emits ``task_recovered`` as its first
    event with ``recovered_from_sequence == 0`` (sequence now always starts
    from 1 since ``_load_last_sequence`` was removed).
    """
    base_dir = tmp_path / "tasks"
    task_id = "task_recovery_append"
    call_count = {"n": 0}
    import app.pipeline.runner as runner_module
    original_processing = runner_module.run_processing

    def flaky_processing(ctx, source_asset, dataset_id, geo=None):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise RuntimeError("simulated crash")
        return original_processing(ctx, source_asset, dataset_id)

    monkeypatch.setattr(runner_module, "run_processing", flaky_processing)

    # First run: fails at processing.
    runner1 = PipelineRunner(
        task_id=task_id, base_dir=base_dir, fixture_dir=FIXTURE_DIR,
    )
    manifest1 = asyncio.run(runner1.run())
    assert manifest1.task_state == TaskState.FAILED

    # Second run: recovers and completes.
    runner2 = PipelineRunner(
        task_id=task_id, base_dir=base_dir, fixture_dir=FIXTURE_DIR,
    )
    manifest2 = asyncio.run(runner2.run())
    assert manifest2.task_state == TaskState.COMPLETED

    # The second run emits task_recovered as its first event, with
    # recovered_from_sequence=0 (sequence always starts from 1 now).
    assert runner2.events[0].payload.type == PipelineEventType.TASK_RECOVERED.value
    assert runner2.events[0].payload.recovered_from_sequence == 0


# ---------------------------------------------------------------------------
# Scenario 4: Stage failure preserves prior events + failure event
# ---------------------------------------------------------------------------


def test_stage_failure_preserves_prior_events_in_jsonl(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A stage failure must not lose prior successful stage events.

    Validates TODO §14 line 388: stage failure preserves complete attempt/event
    history. ``runner.events`` must contain stage_started/stage_completed for
    successful upstream stages AND stage_failed/task_failed for the failed
    stage.
    """
    import app.pipeline.runner as runner_module

    def failing_processing(ctx, source_asset, dataset_id, geo=None):
        raise RuntimeError("simulated processing failure")

    monkeypatch.setattr(runner_module, "run_processing", failing_processing)

    runner = PipelineRunner(
        task_id="task_failure_preserve",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    manifest = asyncio.run(runner.run())
    assert manifest.task_state == TaskState.FAILED

    events = runner.events
    event_types = [e.payload.type for e in events]

    # Prior successful stages (discovery, acquisition) must be preserved.
    assert PipelineEventType.STAGE_STARTED.value in event_types
    assert PipelineEventType.STAGE_COMPLETED.value in event_types
    # The failure events must also be present.
    assert PipelineEventType.STAGE_FAILED.value in event_types
    assert PipelineEventType.TASK_FAILED.value in event_types
    # task_completed must NOT be present (the pipeline failed).
    assert PipelineEventType.TASK_COMPLETED.value not in event_types

    # Sequences must be contiguous starting at 1.
    sequences = [e.sequence for e in events]
    assert sequences == list(range(1, len(events) + 1))

    # Stage attempts in state must also be preserved.
    attempts = runner.state.stage_attempts
    succeeded = [a for a in attempts if a.status == AttemptStatus.SUCCEEDED]
    failed = [a for a in attempts if a.status == AttemptStatus.FAILED]
    assert len(succeeded) >= 2  # discovery + acquisition succeeded
    assert len(failed) == 1  # processing failed


# ---------------------------------------------------------------------------
# Scenario 5: Cancellation preserves prior events + cancel event
# ---------------------------------------------------------------------------


def test_cancellation_preserves_prior_events_in_jsonl(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Cancellation must not lose prior successful stage events.

    Validates TODO §14 line 388: cancellation preserves complete attempt/event
    history. ``runner.events`` must contain stage_completed for successful
    upstream stages AND task_cancelled for the cancellation.
    """
    import app.pipeline.runner as runner_module

    original_acquisition = runner_module.run_acquisition
    runner_holder: dict[str, PipelineRunner | None] = {"runner": None}

    def cancel_after_acquisition(ctx, retrieved_at):
        result = original_acquisition(ctx, retrieved_at)
        runner = runner_holder["runner"]
        assert runner is not None
        runner.request_cancel("test cancel for jsonl preservation")
        return result

    monkeypatch.setattr(runner_module, "run_acquisition", cancel_after_acquisition)

    runner = PipelineRunner(
        task_id="task_cancel_preserve",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    runner_holder["runner"] = runner
    manifest = asyncio.run(runner.run())
    assert manifest.task_state == TaskState.CANCELLED

    events = runner.events
    event_types = [e.payload.type for e in events]

    # Prior successful stages must be preserved.
    assert PipelineEventType.STAGE_COMPLETED.value in event_types
    # The cancel events must be present.
    assert "task_cancel_requested" in event_types
    assert PipelineEventType.TASK_CANCELLED.value in event_types
    # task_completed/task_failed must NOT be present.
    assert PipelineEventType.TASK_COMPLETED.value not in event_types
    assert PipelineEventType.TASK_FAILED.value not in event_types

    # Sequences must be contiguous starting at 1.
    sequences = [e.sequence for e in events]
    assert sequences == list(range(1, len(events) + 1))

    # Stage attempts in state must also be preserved.
    attempts = runner.state.stage_attempts
    succeeded = [a for a in attempts if a.status == AttemptStatus.SUCCEEDED]
    assert len(succeeded) >= 2  # discovery + acquisition succeeded
