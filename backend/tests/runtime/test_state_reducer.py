from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from app.domain.contracts import (
    ArtifactManifestEntry,
    ArtifactProducedPayload,
    AssistantDeltaPayload,
    RunCancelledPayload,
    RunCancelRequestedPayload,
    RunCompletedPayload,
    RunFailedPayload,
    RunFinalizingPayload,
    RunQueuedPayload,
    RunStartedPayload,
    RunStatus,
    TaskMode,
    TaskSnapshot,
    TaskSummary,
    build_event,
)
from app.runtime.state import reduce_task_event

NOW = datetime(2026, 7, 13, tzinfo=UTC)


def empty_snapshot() -> TaskSnapshot:
    return TaskSnapshot(
        task=TaskSummary(
            task_id="task_123",
            mode=TaskMode.AGENT,
            title="TP53 datasets",
            status=RunStatus.COMPLETED,
            created_at=NOW,
            updated_at=NOW,
        )
    )


def test_reducer_projects_legal_run_lifecycle_without_mutating_input() -> None:
    original = empty_snapshot()
    payloads = [
        RunQueuedPayload(request_id="req_123", input="compare TP53 datasets"),
        RunStartedPayload(),
        RunFinalizingPayload(),
        RunCompletedPayload(),
    ]

    snapshot = original
    for sequence, payload in enumerate(payloads, start=1):
        snapshot = reduce_task_event(
            snapshot,
            build_event(
                task_id="task_123",
                run_id="run_123",
                sequence=sequence,
                timestamp=NOW + timedelta(seconds=sequence),
                payload=payload,
            ),
        )

    assert original.runs == []
    assert original.task.latest_sequence == 0
    assert snapshot.runs[0].status is RunStatus.COMPLETED
    assert snapshot.runs[0].started_at == NOW + timedelta(seconds=2)
    assert snapshot.runs[0].finished_at == NOW + timedelta(seconds=4)
    assert snapshot.task.status is RunStatus.COMPLETED
    assert snapshot.task.active_run_id is None
    assert snapshot.task.latest_sequence == 4


def test_reducer_counts_artifact_produced_events() -> None:
    snapshot = queued_snapshot()
    snapshot = reduce_task_event(
        snapshot,
        runtime_event(
            2,
            RunStartedPayload(),
        ),
    )
    snapshot = reduce_task_event(
        snapshot,
        runtime_event(
            3,
            ArtifactProducedPayload(
                artifact=ArtifactManifestEntry(
                    artifact_id="artifact_123",
                    name="result.csv",
                    relative_path="artifacts/result.csv",
                    media_type="text/csv",
                    size_bytes=42,
                    sha256="0" * 64,
                    generated_by_step_id="stage_123",
                )
            ),
        ),
    )
    snapshot = reduce_task_event(
        snapshot,
        runtime_event(
            4,
            RunFinalizingPayload(),
        ),
    )
    snapshot = reduce_task_event(
        snapshot,
        runtime_event(
            5,
            RunCompletedPayload(),
        ),
    )

    assert snapshot.task.artifact_count == 1

def test_reducer_marks_no_artifact_failure_from_latest_run_error() -> None:
    silent = queued_snapshot()
    silent = reduce_task_event(
        silent,
        runtime_event(2, RunStartedPayload()),
    )
    silent = reduce_task_event(
        silent,
        runtime_event(
            3,
            RunFailedPayload(
                error=(
                    "agent completed without producing any artifacts "
                    "(manifest missing or unchanged)"
                )
            ),
        ),
    )
    assert silent.task.no_artifact_failure is True

    real = queued_snapshot()
    real = reduce_task_event(
        real,
        runtime_event(2, RunStartedPayload()),
    )
    real = reduce_task_event(
        real,
        runtime_event(
            3,
            RunFailedPayload(error="model connection timeout"),
        ),
    )
    assert real.task.no_artifact_failure is False


def runtime_event(
    sequence: int,
    payload: object,
    *,
    task_id: str = "task_123",
    run_id: str = "run_123",
):
    return build_event(
        task_id=task_id,
        run_id=run_id,
        sequence=sequence,
        timestamp=NOW + timedelta(seconds=sequence),
        payload=payload,
    )


def queued_snapshot() -> TaskSnapshot:
    return reduce_task_event(
        empty_snapshot(),
        runtime_event(
            1,
            RunQueuedPayload(request_id="req_123", input="question"),
        ),
    )


def test_reducer_rejects_illegal_run_transition() -> None:
    with pytest.raises(ValueError, match="transition"):
        reduce_task_event(
            queued_snapshot(),
            runtime_event(2, RunCompletedPayload()),
        )


def test_reducer_rejects_duplicate_or_stale_task_sequence() -> None:
    snapshot = queued_snapshot()

    with pytest.raises(ValueError, match="sequence"):
        reduce_task_event(snapshot, runtime_event(1, RunStartedPayload()))


def test_reducer_rejects_event_for_another_task() -> None:
    with pytest.raises(ValueError, match="task_id"):
        reduce_task_event(
            empty_snapshot(),
            runtime_event(
                1,
                RunQueuedPayload(request_id="req_123", input="question"),
                task_id="task_other",
            ),
        )


def test_reducer_rejects_duplicate_and_unknown_runs() -> None:
    snapshot = queued_snapshot()

    with pytest.raises(ValueError, match="already exists"):
        reduce_task_event(
            snapshot,
            runtime_event(
                2,
                RunQueuedPayload(request_id="req_other", input="duplicate"),
            ),
        )

    with pytest.raises(ValueError, match="unknown run_id"):
        reduce_task_event(
            snapshot,
            runtime_event(
                2,
                AssistantDeltaPayload(delta="orphan"),
                run_id="run_other",
            ),
        )


def test_reducer_rejects_second_run_while_first_is_active() -> None:
    with pytest.raises(ValueError, match="active run"):
        reduce_task_event(
            queued_snapshot(),
            runtime_event(
                2,
                RunQueuedPayload(request_id="req_456", input="second turn"),
                run_id="run_456",
            ),
        )


def test_reducer_accepts_new_run_after_prior_run_is_terminal() -> None:
    snapshot = queued_snapshot()
    for sequence, payload in enumerate(
        [RunStartedPayload(), RunFinalizingPayload(), RunCompletedPayload()],
        start=2,
    ):
        snapshot = reduce_task_event(snapshot, runtime_event(sequence, payload))

    snapshot = reduce_task_event(
        snapshot,
        runtime_event(
            5,
            RunQueuedPayload(request_id="req_456", input="second turn"),
            run_id="run_456",
        ),
    )

    assert len(snapshot.runs) == 2
    assert snapshot.task.active_run_id == "run_456"
    assert snapshot.task.status is RunStatus.QUEUED


def test_terminal_run_is_immutable() -> None:
    snapshot = queued_snapshot()
    for sequence, payload in enumerate(
        [RunStartedPayload(), RunFinalizingPayload(), RunCompletedPayload()],
        start=2,
    ):
        snapshot = reduce_task_event(snapshot, runtime_event(sequence, payload))

    with pytest.raises(ValueError, match="terminal"):
        reduce_task_event(
            snapshot,
            runtime_event(5, AssistantDeltaPayload(delta="too late")),
        )


def test_queued_run_can_be_cancelled_without_starting() -> None:
    snapshot = reduce_task_event(
        queued_snapshot(),
        runtime_event(2, RunCancelRequestedPayload(reason="user requested")),
    )
    snapshot = reduce_task_event(
        snapshot,
        runtime_event(3, RunCancelledPayload(reason="user requested")),
    )

    assert snapshot.runs[0].status is RunStatus.CANCELLED
    assert snapshot.runs[0].started_at is None
    assert snapshot.runs[0].finished_at == NOW + timedelta(seconds=3)
