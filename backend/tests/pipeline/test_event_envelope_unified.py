"""Integration tests for the unified WebSocket Event Envelope (TODO.md §11).

Covers:
    1. EventEnvelope carries schema_version, event_id, sequence, timestamp.
    2. Per-event persistence: events.jsonl is appended as events are emitted,
       not rewritten at terminal state.
    3. run_streamed() yields EventEnvelope objects in order with persist-then-push.
    4. GET /api/v1/tasks/{task_id}/events?since=N replay endpoint.
    5. WS run_pipeline message type streams EventEnvelope events.
    6. Recovery appends (not overwrites) prior events in events.jsonl.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import app.api.routes as routes_module
import httpx
import pytest
from app.domain.contracts import (
    EventEnvelope,
    PipelineEventType,
    TaskState,
)
from app.main import app
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
# Scenario 4: GET /api/v1/tasks/{task_id}/events?since=N replay
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_events_replay_endpoint_returns_events_after_since(
    tmp_path: Path, monkeypatch
) -> None:
    """GET /tasks/{id}/events?since=N returns only events with sequence > N."""
    output_dir = tmp_path / "output"
    runner = PipelineRunner(
        task_id="task_replay",
        base_dir=output_dir / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    await runner.run()
    monkeypatch.setattr(
        routes_module, "settings", SimpleNamespace(output_dir=str(output_dir))
    )

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        # Full replay (since=0).
        resp = await client.get("/api/v1/tasks/task_replay/events")
        assert resp.status_code == 200
        body = resp.json()
        assert body["task_id"] == "task_replay"
        assert body["since"] == 0
        all_events = body["events"]
        assert len(all_events) > 0
        sequences = [e["sequence"] for e in all_events]
        assert sequences == list(range(1, len(all_events) + 1))

        # Partial replay: since = midpoint.
        midpoint = len(all_events) // 2
        since_value = all_events[midpoint - 1]["sequence"]
        resp2 = await client.get(f"/api/v1/tasks/task_replay/events?since={since_value}")
        assert resp2.status_code == 200
        partial = resp2.json()["events"]
        assert len(partial) == len(all_events) - midpoint
        assert all(e["sequence"] > since_value for e in partial)

        # 404 for unknown task.
        resp3 = await client.get("/api/v1/tasks/nonexistent_task/events")
        assert resp3.status_code == 404


# ---------------------------------------------------------------------------
# Scenario 5: WS run_pipeline streams EventEnvelope events
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ws_run_pipeline_streams_event_envelopes(
    tmp_path: Path, monkeypatch
) -> None:
    """WS run_pipeline must stream typed EventEnvelope dicts to the client."""
    output_dir = tmp_path / "output"
    monkeypatch.setattr(
        routes_module, "settings", SimpleNamespace(output_dir=str(output_dir))
    )
    # The WS handler imports settings from app.config, not routes_module.
    import app.api.ws as ws_module
    monkeypatch.setattr(
        ws_module, "settings", SimpleNamespace(output_dir=str(output_dir))
    )

    from starlette.testclient import TestClient

    with TestClient(app) as client, client.websocket_connect("/api/v1/ws") as ws:
        ws.send_json({
            "type": "run_pipeline",
            "topic": "breast cancer gene expression under Hsp70 inhibition",
        })
        events: list[dict] = []
        # Read until we see a terminal event or hit a safety cap.
        while len(events) < 50:
            raw = ws.receive_json()
            if raw.get("type") == "error":
                pytest.fail(f"server error: {raw.get('message')}")
            events.append(raw)
            if raw.get("type") in {
                PipelineEventType.TASK_COMPLETED.value,
                PipelineEventType.TASK_FAILED.value,
            }:
                break

    assert len(events) > 0
    # Every event must carry the EventEnvelope field set.
    required = {"schema_version", "event_id", "type", "task_id", "sequence", "timestamp", "payload"}
    for event in events:
        assert required <= set(event), f"missing fields: {required - set(event)}"
        assert event["schema_version"] == "1.0"
    # Sequences are contiguous starting at 1.
    sequences = [e["sequence"] for e in events]
    assert sequences == list(range(1, len(events) + 1))
    assert events[0]["type"] == PipelineEventType.TASK_CREATED.value
    assert events[-1]["type"] == PipelineEventType.TASK_COMPLETED.value


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
