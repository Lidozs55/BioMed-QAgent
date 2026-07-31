from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from app.domain.contracts import (
    RunRecord,
    RunStatus,
    SubagentCancelledPayload,
    SubagentCancelRequestedPayload,
    SubagentCompletedPayload,
    SubagentFailedPayload,
    SubagentInputRequiredPayload,
    SubagentInputResumedPayload,
    SubagentInterruptedPayload,
    SubagentProgressPayload,
    SubagentQueuedPayload,
    SubagentRequest,
    SubagentResult,
    SubagentStartedPayload,
    SubagentStatus,
    SubagentType,
    TaskMode,
    TaskSnapshot,
    TaskSummary,
    build_event,
)
from app.runtime.state import reduce_task_event

NOW = datetime(2026, 7, 28, tzinfo=UTC)


def _snapshot() -> TaskSnapshot:
    return TaskSnapshot(
        task=TaskSummary(
            task_id="task_1",
            mode=TaskMode.AGENT,
            title="Find public cohort metadata",
            status=RunStatus.RUNNING,
            active_run_id="run_1",
            created_at=NOW,
            updated_at=NOW,
            latest_sequence=1,
        ),
        runs=[
            RunRecord(
                run_id="run_1",
                task_id="task_1",
                request_id="request_1",
                status=RunStatus.RUNNING,
                input="Find public cohort metadata",
                created_at=NOW,
                updated_at=NOW,
                started_at=NOW,
            )
        ],
    )


def _event(
    sequence: int,
    payload: object,
    *,
    subagent_id: str = "subagent_1",
    run_id: str = "run_1",
):
    return build_event(
        task_id="task_1",
        run_id=run_id,
        sequence=sequence,
        timestamp=NOW + timedelta(seconds=sequence),
        subagent_id=subagent_id,
        parent_tool_call_id="call_1",
        payload=payload,
    )


def _queued_event(sequence: int, *, subagent_id: str = "subagent_1"):
    return _event(
        sequence,
        SubagentQueuedPayload(
            subagent_id=subagent_id,
            request=SubagentRequest(
                agent_type=SubagentType.SOURCE_RESEARCH,
                objective="Find public cohort metadata",
                target_source="GEO",
                domain="ncbi.nlm.nih.gov",
                capability="metadata_search",
            ),
        ),
        subagent_id=subagent_id,
    )


def _started_event(sequence: int, *, subagent_id: str = "subagent_1"):
    return _event(
        sequence,
        SubagentStartedPayload(subagent_id=subagent_id),
        subagent_id=subagent_id,
    )


def _completed_event(
    sequence: int,
    *,
    subagent_id: str = "subagent_1",
    summary: str = "Found one source asset",
):
    return _event(
        sequence,
        SubagentCompletedPayload(
            subagent_id=subagent_id,
            result=SubagentResult(
                subagent_id=subagent_id,
                status=SubagentStatus.COMPLETED,
                summary=summary,
                source_asset_ids=["source_1"],
            ),
        ),
        subagent_id=subagent_id,
    )


def _terminal_event(sequence: int, status: SubagentStatus):
    result = SubagentResult(
        subagent_id="subagent_1",
        status=status,
        summary=f"Reached {status}",
    )
    payload_by_status = {
        SubagentStatus.FAILED: SubagentFailedPayload,
        SubagentStatus.CANCELLED: SubagentCancelledPayload,
        SubagentStatus.INTERRUPTED: SubagentInterruptedPayload,
    }
    return _event(
        sequence,
        payload_by_status[status](subagent_id="subagent_1", result=result),
    )


def _input_required_event(sequence: int, request_id: str, *, subagent_id: str = "subagent_1"):
    return _event(
        sequence,
        SubagentInputRequiredPayload(
            subagent_id=subagent_id,
            request_id=request_id,
            summary="Confirm access terms",
            prompt_kind="terms_approval",
        ),
        subagent_id=subagent_id,
    )


def _input_resumed_event(sequence: int, request_id: str, *, subagent_id: str = "subagent_1"):
    return _event(
        sequence,
        SubagentInputResumedPayload(
            subagent_id=subagent_id,
            request_id=request_id,
            decision="approve",
        ),
        subagent_id=subagent_id,
    )


def _running_subagent_snapshot() -> TaskSnapshot:
    snapshot = reduce_task_event(_snapshot(), _queued_event(sequence=2))
    return reduce_task_event(snapshot, _started_event(sequence=3))


def test_reducer_projects_subagent_lifecycle() -> None:
    snapshot = _snapshot()
    snapshot = reduce_task_event(snapshot, _queued_event(sequence=2))
    snapshot = reduce_task_event(snapshot, _started_event(sequence=3))
    snapshot = reduce_task_event(snapshot, _completed_event(sequence=4))

    record = snapshot.subagents[0]
    assert record.status is SubagentStatus.COMPLETED
    assert record.source_asset_ids == ["source_1"]
    assert record.finished_at == NOW + timedelta(seconds=4)
    assert snapshot.task.status is RunStatus.RUNNING
    assert snapshot.runs[0].status is RunStatus.RUNNING


def test_reducer_rejects_completed_to_running_transition() -> None:
    snapshot = reduce_task_event(_snapshot(), _queued_event(sequence=2))
    snapshot = reduce_task_event(snapshot, _started_event(sequence=3))
    snapshot = reduce_task_event(snapshot, _completed_event(sequence=4))

    with pytest.raises(ValueError, match="invalid subagent transition"):
        reduce_task_event(snapshot, _started_event(sequence=5))


def test_reducer_rejects_subagent_event_for_another_parent_run() -> None:
    snapshot = reduce_task_event(_snapshot(), _queued_event(sequence=2))
    snapshot = snapshot.model_copy(
        update={
            "runs": [
                *snapshot.runs,
                RunRecord(
                    run_id="run_2",
                    task_id="task_1",
                    request_id="request_2",
                    status=RunStatus.COMPLETED,
                    input="Previous question",
                    created_at=NOW,
                    updated_at=NOW,
                    finished_at=NOW,
                ),
            ]
        }
    )

    with pytest.raises(ValueError, match="subagent run_id"):
        reduce_task_event(
            snapshot,
            _event(
                3,
                SubagentProgressPayload(subagent_id="subagent_1", current=1),
                run_id="run_2",
            ),
        )


def test_reducer_rejects_subagent_event_for_mismatched_record_task() -> None:
    snapshot = reduce_task_event(_snapshot(), _queued_event(sequence=2))
    record = snapshot.subagents[0].model_copy(update={"task_id": "task_legacy"})
    snapshot = snapshot.model_copy(update={"subagents": [record]})

    with pytest.raises(ValueError, match="subagent task_id"):
        reduce_task_event(
            snapshot,
            _event(3, SubagentProgressPayload(subagent_id="subagent_1", current=1)),
        )


@pytest.mark.parametrize(
    ("prelude", "terminal_status"),
    [
        ([], SubagentStatus.INTERRUPTED),
        ([SubagentStartedPayload(subagent_id="subagent_1")], SubagentStatus.FAILED),
        (
            [
                SubagentCancelRequestedPayload(
                    subagent_id="subagent_1",
                    reason="User cancelled",
                )
            ],
            SubagentStatus.CANCELLED,
        ),
    ],
)
def test_reducer_projects_remaining_subagent_terminal_lifecycles(
    prelude: list[SubagentStartedPayload | SubagentCancelRequestedPayload],
    terminal_status: SubagentStatus,
) -> None:
    snapshot = reduce_task_event(_snapshot(), _queued_event(sequence=2))
    for sequence, payload in enumerate(prelude, start=3):
        snapshot = reduce_task_event(snapshot, _event(sequence, payload))

    snapshot = reduce_task_event(
        snapshot,
        _terminal_event(3 + len(prelude), terminal_status),
    )

    assert snapshot.subagents[0].status is terminal_status
    assert snapshot.subagents[0].finished_at is not None


@pytest.mark.parametrize("status", [SubagentStatus.QUEUED, SubagentStatus.CANCEL_REQUESTED])
def test_reducer_rejects_input_required_when_subagent_is_not_running(
    status: SubagentStatus,
) -> None:
    snapshot = reduce_task_event(_snapshot(), _queued_event(sequence=2))
    sequence = 3
    if status is SubagentStatus.CANCEL_REQUESTED:
        snapshot = reduce_task_event(
            snapshot,
            _event(
                sequence,
                SubagentCancelRequestedPayload(subagent_id="subagent_1"),
            ),
        )
        sequence += 1

    with pytest.raises(ValueError, match="input required"):
        reduce_task_event(snapshot, _input_required_event(sequence, "input_1"))


def test_reducer_accepts_identical_input_required_event_idempotently() -> None:
    snapshot = _running_subagent_snapshot()
    snapshot = reduce_task_event(snapshot, _input_required_event(4, "input_1"))
    snapshot = reduce_task_event(snapshot, _input_required_event(5, "input_1"))

    assert snapshot.subagents[0].pending_request_id == "input_1"
    assert snapshot.task.latest_sequence == 5


def test_reducer_rejects_conflicting_input_required_request() -> None:
    snapshot = _running_subagent_snapshot()
    snapshot = reduce_task_event(snapshot, _input_required_event(4, "input_1"))

    with pytest.raises(ValueError, match="pending input"):
        reduce_task_event(snapshot, _input_required_event(5, "input_2"))


def test_reducer_rejects_resume_without_pending_input() -> None:
    with pytest.raises(ValueError, match="pending input"):
        reduce_task_event(_running_subagent_snapshot(), _input_resumed_event(4, "input_1"))


def test_reducer_rejects_resume_for_mismatched_input_request() -> None:
    snapshot = _running_subagent_snapshot()
    snapshot = reduce_task_event(snapshot, _input_required_event(4, "input_1"))

    with pytest.raises(ValueError, match="pending input"):
        reduce_task_event(snapshot, _input_resumed_event(5, "input_2"))


def test_reducer_resumes_matching_input_without_changing_sibling() -> None:
    snapshot = reduce_task_event(_snapshot(), _queued_event(sequence=2))
    snapshot = reduce_task_event(snapshot, _queued_event(sequence=3, subagent_id="subagent_2"))
    snapshot = reduce_task_event(snapshot, _started_event(sequence=4))
    snapshot = reduce_task_event(snapshot, _input_required_event(5, "input_1"))
    snapshot = reduce_task_event(snapshot, _input_resumed_event(6, "input_1"))

    first, second = snapshot.subagents
    assert first.pending_request_id is None
    assert second.pending_request_id is None
    assert snapshot.runs[0].status is RunStatus.RUNNING


def test_reducer_projects_progress_and_hil_only_to_matching_subagent() -> None:
    snapshot = reduce_task_event(_snapshot(), _queued_event(sequence=2))
    snapshot = reduce_task_event(snapshot, _queued_event(sequence=3, subagent_id="subagent_2"))
    snapshot = reduce_task_event(snapshot, _started_event(sequence=4))
    snapshot = reduce_task_event(
        snapshot,
        _event(
            5,
            SubagentProgressPayload(
                subagent_id="subagent_1",
                current=2,
                total=3,
                message="Parsing metadata",
            ),
        ),
    )
    snapshot = reduce_task_event(
        snapshot,
        _event(
            6,
            SubagentInputRequiredPayload(
                subagent_id="subagent_1",
                request_id="input_1",
                summary="Confirm access terms",
                prompt_kind="terms_approval",
            ),
        ),
    )
    snapshot = reduce_task_event(
        snapshot,
        _event(
            7,
            SubagentInputResumedPayload(
                subagent_id="subagent_1",
                request_id="input_1",
                decision="approve",
            ),
        ),
    )

    first, second = snapshot.subagents
    assert first.progress_current == 2
    assert first.progress_total == 3
    assert first.progress_message == "Parsing metadata"
    assert first.pending_request_id is None
    assert second.progress_current == 0
    assert second.pending_request_id is None
    assert snapshot.task.status is RunStatus.RUNNING
    assert snapshot.runs[0].status is RunStatus.RUNNING


def test_reducer_accepts_identical_terminal_event_idempotently() -> None:
    snapshot = reduce_task_event(_snapshot(), _queued_event(sequence=2))
    snapshot = reduce_task_event(snapshot, _started_event(sequence=3))
    snapshot = reduce_task_event(snapshot, _completed_event(sequence=4))
    finished_at = snapshot.subagents[0].finished_at

    snapshot = reduce_task_event(snapshot, _completed_event(sequence=5))

    assert snapshot.subagents[0].finished_at == finished_at
    assert snapshot.task.latest_sequence == 5


def test_reducer_rejects_conflicting_terminal_event() -> None:
    snapshot = reduce_task_event(_snapshot(), _queued_event(sequence=2))
    snapshot = reduce_task_event(snapshot, _started_event(sequence=3))
    snapshot = reduce_task_event(snapshot, _completed_event(sequence=4))

    with pytest.raises(ValueError, match="invalid subagent transition"):
        reduce_task_event(
            snapshot,
            _event(
                5,
                SubagentFailedPayload(
                    subagent_id="subagent_1",
                    result=SubagentResult(
                        subagent_id="subagent_1",
                        status=SubagentStatus.FAILED,
                        summary="Failed",
                    ),
                ),
            ),
        )
