"""Integration tests for the unified WebSocket Event Envelope (TODO.md §11).

Covers:
    1. EventEnvelope carries schema_version, event_id, sequence, timestamp.
    2. Per-event persistence: events.jsonl is appended as events are emitted,
       not rewritten at terminal state.
    3. run_streamed() yields EventEnvelope objects in order with persist-then-push.
    4-5. (Legacy REST/WS envelope) — superseded by tests/api/test_rest_control.py
         and tests/api/test_websocket_replay.py (durable event API).
    6. Recovery appends (not overwrites) prior events in events.jsonl.
    7. Stage failure preserves prior events + failure event in events.jsonl.
    8. Cancellation preserves prior events + cancel event in events.jsonl.
"""
from __future__ import annotations

import asyncio
import json
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


def _read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text("utf-8").splitlines() if line]


# ---------------------------------------------------------------------------
# Scenario 1: EventEnvelope schema_version + canonical fields
# ---------------------------------------------------------------------------


def test_event_envelope_carries_schema_version_and_canonical_fields(
    tmp_path: Path,
) -> None:
    """Every persisted event must carry schema_version + the §11 field set."""
    runner = PipelineRunner(
        task_id="task_envelope_fields",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    asyncio.run(runner.run())

    events_file = tmp_path / "tasks" / "task_envelope_fields" / "logs" / "events.jsonl"
    events = _read_jsonl(events_file)
    assert len(events) > 0

    required_fields = {
        "schema_version", "event_id", "type", "task_id",
        "sequence", "timestamp", "payload",
    }
    for raw in events:
        assert required_fields <= set(raw), (
            f"event missing fields: {required_fields - set(raw)}"
        )
        assert raw["schema_version"] == "1.0"
        assert raw["task_id"] == "task_envelope_fields"
        # Validate the envelope round-trips through the typed contract.
        envelope = EventEnvelope.model_validate(raw)
        assert envelope.type.value == raw["type"]


# ---------------------------------------------------------------------------
# Scenario 2: Per-event persistence (not terminal-only)
# ---------------------------------------------------------------------------


def test_events_jsonl_is_appended_per_event_not_rewritten_at_terminal(
    tmp_path: Path, monkeypatch
) -> None:
    """events.jsonl must be written as events are emitted, not at terminal only.

    The old terminal-only persistence wrote events.jsonl once in _persist_logs
    at the end. The new per-event persistence appends each event in
    _persist_event before pushing to the queue. We prove this by checking that
    events.jsonl already has content after the FIRST streamed event — which
    would be impossible under terminal-only persistence (the run has not
    finished yet).
    """
    runner = PipelineRunner(
        task_id="task_per_event_persist",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    events_file = (
        tmp_path / "tasks" / "task_per_event_persist" / "logs" / "events.jsonl"
    )

    first_event_lines: int | None = None
    total_streamed = 0

    async def _collect() -> None:
        nonlocal first_event_lines, total_streamed
        async for _ in runner.run_streamed():
            total_streamed += 1
            if first_event_lines is None and events_file.is_file():
                # Capture the line count right after the first event was
                # yielded — the file must already contain at least 1 event.
                first_event_lines = len(_read_jsonl(events_file))

    asyncio.run(_collect())
    assert runner.manifest is not None
    assert runner.manifest.task_state == TaskState.COMPLETED
    assert total_streamed >= 7

    # After the first streamed event, events.jsonl already had content.
    # Under terminal-only persistence this would be 0 (file not written yet).
    assert first_event_lines is not None
    assert first_event_lines >= 1, (
        "events.jsonl was empty after first event — terminal-only persistence"
    )

    # Final line count must equal the number of streamed events.
    final_lines = len(_read_jsonl(events_file))
    assert final_lines == total_streamed, (
        f"events.jsonl has {final_lines} lines but {total_streamed} events were streamed"
    )


# ---------------------------------------------------------------------------
# Scenario 3: run_streamed yields typed EventEnvelope in sequence order
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
# Scenario 6: Recovery appends (not overwrites) prior events
# ---------------------------------------------------------------------------


def test_recovery_appends_events_without_overwriting_prior_ones(
    tmp_path: Path, monkeypatch
) -> None:
    """A recovery run must append to events.jsonl, not overwrite prior events.

    This validates the fix for the old terminal-only persistence which rewrote
    events.jsonl from self.events (empty on recovery), losing prior events.
    """
    base_dir = tmp_path / "tasks"
    task_id = "task_recovery_append"
    call_count = {"n": 0}
    import app.pipeline.runner as runner_module
    original_processing = runner_module.run_processing

    def flaky_processing(ctx, source_asset, dataset_id):
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

    events_file = base_dir / task_id / "logs" / "events.jsonl"
    events_run1 = _read_jsonl(events_file)
    assert len(events_run1) > 0
    run1_max_sequence = max(e["sequence"] for e in events_run1)

    # Second run: recovers and completes.
    runner2 = PipelineRunner(
        task_id=task_id, base_dir=base_dir, fixture_dir=FIXTURE_DIR,
    )
    manifest2 = asyncio.run(runner2.run())
    assert manifest2.task_state == TaskState.COMPLETED

    events_run2 = _read_jsonl(events_file)
    # Recovery must append, so total events > run1 events.
    assert len(events_run2) > len(events_run1)
    # The first run's events are still present (not overwritten).
    run2_sequences = {e["sequence"] for e in events_run2}
    for e in events_run1:
        assert e["sequence"] in run2_sequences, (
            f"prior event seq={e['sequence']} lost after recovery"
        )
    # New events have sequences continuing past run1's max.
    new_sequences = [e["sequence"] for e in events_run2 if e["sequence"] > run1_max_sequence]
    assert len(new_sequences) > 0
    # task_recovered event must appear among the new events.
    new_types = [e["type"] for e in events_run2 if e["sequence"] > run1_max_sequence]
    assert PipelineEventType.TASK_RECOVERED.value in new_types


# ---------------------------------------------------------------------------
# Scenario 7: Stage failure preserves prior events + failure event in jsonl
# ---------------------------------------------------------------------------


def test_stage_failure_preserves_prior_events_in_jsonl(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A stage failure must not lose prior successful stage events from events.jsonl.

    Validates TODO §14 line 388: stage failure preserves complete attempt/event
    history. The events.jsonl file must contain stage_started/stage_completed
    for successful upstream stages AND stage_failed/task_failed for the failed
    stage.
    """
    import app.pipeline.runner as runner_module

    def failing_processing(ctx, source_asset, dataset_id):
        raise RuntimeError("simulated processing failure")

    monkeypatch.setattr(runner_module, "run_processing", failing_processing)

    runner = PipelineRunner(
        task_id="task_failure_preserve",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    manifest = asyncio.run(runner.run())
    assert manifest.task_state == TaskState.FAILED

    events_file = tmp_path / "tasks" / "task_failure_preserve" / "logs" / "events.jsonl"
    events = _read_jsonl(events_file)
    event_types = [e["type"] for e in events]

    # Prior successful stages (discovery, acquisition) must be preserved.
    assert PipelineEventType.STAGE_STARTED.value in event_types
    assert PipelineEventType.STAGE_COMPLETED.value in event_types
    # The failure events must also be present.
    assert PipelineEventType.STAGE_FAILED.value in event_types
    assert PipelineEventType.TASK_FAILED.value in event_types
    # task_completed must NOT be present (the pipeline failed).
    assert PipelineEventType.TASK_COMPLETED.value not in event_types

    # Sequences must be contiguous starting at 1.
    sequences = [e["sequence"] for e in events]
    assert sequences == list(range(1, len(events) + 1))

    # Stage attempts in state must also be preserved.
    attempts = runner.state.stage_attempts
    succeeded = [a for a in attempts if a.status == AttemptStatus.SUCCEEDED]
    failed = [a for a in attempts if a.status == AttemptStatus.FAILED]
    assert len(succeeded) >= 2  # discovery + acquisition succeeded
    assert len(failed) == 1  # processing failed


# ---------------------------------------------------------------------------
# Scenario 8: Cancellation preserves prior events + cancel event in jsonl
# ---------------------------------------------------------------------------


def test_cancellation_preserves_prior_events_in_jsonl(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Cancellation must not lose prior successful stage events from events.jsonl.

    Validates TODO §14 line 388: cancellation preserves complete attempt/event
    history. The events.jsonl file must contain stage_completed for successful
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

    events_file = tmp_path / "tasks" / "task_cancel_preserve" / "logs" / "events.jsonl"
    events = _read_jsonl(events_file)
    event_types = [e["type"] for e in events]

    # Prior successful stages must be preserved.
    assert PipelineEventType.STAGE_COMPLETED.value in event_types
    # The cancel events must be present.
    assert "task_cancel_requested" in event_types
    assert PipelineEventType.TASK_CANCELLED.value in event_types
    # task_completed/task_failed must NOT be present.
    assert PipelineEventType.TASK_COMPLETED.value not in event_types
    assert PipelineEventType.TASK_FAILED.value not in event_types

    # Sequences must be contiguous starting at 1.
    sequences = [e["sequence"] for e in events]
    assert sequences == list(range(1, len(events) + 1))

    # Stage attempts in state must also be preserved.
    attempts = runner.state.stage_attempts
    succeeded = [a for a in attempts if a.status == AttemptStatus.SUCCEEDED]
    assert len(succeeded) >= 2  # discovery + acquisition succeeded
