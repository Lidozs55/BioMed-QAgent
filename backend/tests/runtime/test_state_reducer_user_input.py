"""Tests for the human-in-the-loop pause-resume state machine.

Covers RunStatus.AWAITING_USER_INPUT transitions and the
UserInputRequiredPayload / UserInputResumedPayload projection rules.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from app.domain.contracts import (
    RunQueuedPayload,
    RunStartedPayload,
    RunStatus,
    TaskMode,
    TaskSnapshot,
    TaskSummary,
    UserInputRequiredPayload,
    UserInputResumedPayload,
    build_event,
)
from app.runtime.state import reduce_task_event

NOW = datetime(2026, 7, 17, tzinfo=UTC)
TASK_ID = "task_hitl"
RUN_ID = "run_hitl"


def _empty_snapshot(status: RunStatus = RunStatus.COMPLETED) -> TaskSnapshot:
    return TaskSnapshot(
        task=TaskSummary(
            task_id=TASK_ID,
            mode=TaskMode.AGENT,
            title="hitl test",
            status=status,
            created_at=NOW,
            updated_at=NOW,
        )
    )


def _apply(snapshot: TaskSnapshot, sequence: int, payload: object) -> TaskSnapshot:
    return reduce_task_event(
        snapshot,
        build_event(
            task_id=TASK_ID,
            run_id=RUN_ID,
            sequence=sequence,
            timestamp=NOW + timedelta(seconds=sequence),
            payload=payload,
        ),
    )


def _seed_running() -> TaskSnapshot:
    """Build a snapshot with one run in RUNNING state."""
    snapshot = _empty_snapshot()
    snapshot = _apply(snapshot, 1, RunQueuedPayload(request_id="req_1", input="hi"))
    return _apply(snapshot, 2, RunStartedPayload())


def test_running_to_awaiting_user_input_is_legal() -> None:
    snapshot = _seed_running()
    snapshot = _apply(
        snapshot,
        3,
        UserInputRequiredPayload(
            request_id="req_plan",
            prompt_kind="plan_confirmation",
            summary="confirm plan",
        ),
    )
    assert snapshot.runs[0].status is RunStatus.AWAITING_USER_INPUT
    assert snapshot.task.status is RunStatus.AWAITING_USER_INPUT
    # AWAITING_USER_INPUT is not terminal: active_run_id is preserved.
    assert snapshot.task.active_run_id == RUN_ID
    # started_at is preserved from the RUNNING transition.
    assert snapshot.runs[0].started_at == NOW + timedelta(seconds=2)
    # finished_at stays None until terminal.
    assert snapshot.runs[0].finished_at is None


def test_awaiting_user_input_to_running_resume_preserves_started_at() -> None:
    snapshot = _seed_running()
    snapshot = _apply(
        snapshot,
        3,
        UserInputRequiredPayload(
            request_id="req_plan",
            prompt_kind="plan_confirmation",
            summary="confirm plan",
        ),
    )
    snapshot = _apply(
        snapshot,
        4,
        UserInputResumedPayload(
            request_id="req_plan",
            decision="approve",
        ),
    )
    assert snapshot.runs[0].status is RunStatus.RUNNING
    # started_at must NOT be overwritten by the resume transition.
    assert snapshot.runs[0].started_at == NOW + timedelta(seconds=2)
    assert snapshot.task.status is RunStatus.RUNNING
    assert snapshot.task.active_run_id == RUN_ID


def test_awaiting_user_input_to_cancel_requested_is_legal() -> None:
    from app.domain.contracts import RunCancelRequestedPayload

    snapshot = _seed_running()
    snapshot = _apply(
        snapshot,
        3,
        UserInputRequiredPayload(
            request_id="req_plan",
            prompt_kind="plan_confirmation",
            summary="confirm plan",
        ),
    )
    snapshot = _apply(
        snapshot,
        4,
        RunCancelRequestedPayload(reason="user cancelled during pause"),
    )
    assert snapshot.runs[0].status is RunStatus.CANCEL_REQUESTED


def test_awaiting_user_input_to_failed_is_legal() -> None:
    from app.domain.contracts import RunFailedPayload

    snapshot = _seed_running()
    snapshot = _apply(
        snapshot,
        3,
        UserInputRequiredPayload(
            request_id="req_plan",
            prompt_kind="plan_confirmation",
            summary="confirm plan",
        ),
    )
    snapshot = _apply(
        snapshot,
        4,
        RunFailedPayload(error="resume timeout"),
    )
    assert snapshot.runs[0].status is RunStatus.FAILED
    assert snapshot.runs[0].error == "resume timeout"


def test_queued_to_awaiting_user_input_is_illegal() -> None:
    snapshot = _empty_snapshot()
    snapshot = _apply(snapshot, 1, RunQueuedPayload(request_id="req_1", input="hi"))
    with pytest.raises(ValueError, match="illegal run status transition"):
        _apply(
            snapshot,
            2,
            UserInputRequiredPayload(
                request_id="req_plan",
                prompt_kind="plan_confirmation",
                summary="confirm plan",
            ),
        )


def test_user_input_required_requires_run_id() -> None:
    """A schema-1.0 in-pipeline event with no run_id cannot mutate run state."""
    snapshot = _seed_running()
    with pytest.raises(ValueError, match="run-scoped events require run_id"):
        reduce_task_event(
            snapshot,
            build_event(
                task_id=TASK_ID,
                run_id=None,
                sequence=3,
                timestamp=NOW + timedelta(seconds=3),
                payload=UserInputRequiredPayload(
                    request_id="req_plan",
                    prompt_kind="plan_confirmation",
                    summary="confirm plan",
                ),
            ),
        )
