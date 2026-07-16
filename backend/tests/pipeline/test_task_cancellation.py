"""Tests for task cancellation (TODO.md §11 lines 336, 341).

Covers:
    1. request_cancel() emits task_cancel_requested event (persisted + pushed).
    2. A pipeline run with cancel_requested set before a stage transitions to
       CANCELLED and emits task_cancelled.
    3-5. (Legacy REST/WS cancel API) — superseded by
         tests/api/test_rest_control.py and tests/api/test_websocket_replay.py
         which cover the durable cancel endpoints.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

from app.domain.contracts import (
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
# Scenario 1: request_cancel emits task_cancel_requested
# ---------------------------------------------------------------------------


def test_request_cancel_emits_task_cancel_requested_event(
    tmp_path: Path,
) -> None:
    """request_cancel() must emit a persisted task_cancel_requested event."""
    runner = PipelineRunner(
        task_id="task_cancel_req",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )

    # Drive the pipeline briefly, then cancel mid-run. We use run_streamed so
    # the runner instance is accessible for request_cancel.
    async def _driver() -> None:
        async for _ in runner.run_streamed():
            runner.request_cancel(reason="user requested")
            return  # stop consuming after first event + cancel

    asyncio.run(_driver())

    events_file = (
        tmp_path / "tasks" / "task_cancel_req" / "logs" / "events.jsonl"
    )
    events = _read_jsonl(events_file)
    types = [e["type"] for e in events]
    assert PipelineEventType.TASK_CANCEL_REQUESTED.value in types


# ---------------------------------------------------------------------------
# Scenario 2: cancel_requested → CANCELLED + task_cancelled event
# ---------------------------------------------------------------------------


def test_pipeline_with_cancel_flag_transitions_to_cancelled(
    tmp_path: Path,
) -> None:
    """A run with cancel_requested pre-set must end in CANCELLED."""
    runner = PipelineRunner(
        task_id="task_cancel_pre",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    # Pre-set the cancel flag and persist it, then run.
    runner.state.cancel_requested = True
    runner.state.cancel_reason = "pre-set"
    from app.pipeline.state import save_state
    save_state(runner.workdir.state, runner.state)

    manifest = asyncio.run(runner.run())
    assert manifest.task_state == TaskState.CANCELLED

    events_file = (
        tmp_path / "tasks" / "task_cancel_pre" / "logs" / "events.jsonl"
    )
    events = _read_jsonl(events_file)
    types = [e["type"] for e in events]
    assert PipelineEventType.TASK_CANCELLED.value in types
    # task_cancel_requested is NOT emitted here because the cancel flag was
    # set externally (not via request_cancel). Only request_cancel emits it.
    assert PipelineEventType.TASK_CANCEL_REQUESTED.value not in types


# ---------------------------------------------------------------------------
# Scenario 3-5 (legacy REST/WS cancel API) — superseded by
# tests/api/test_rest_control.py (POST /tasks/{id}/runs/{run_id}/cancel)
# and tests/api/test_websocket_replay.py (durable WS cancel protocol).
# ---------------------------------------------------------------------------
