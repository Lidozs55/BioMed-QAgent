"""Pure projection of persisted events into authoritative task state."""

from __future__ import annotations

from app.domain.contracts import (
    EventEnvelope,
    RunCancelRequestedPayload,
    RunCancelledPayload,
    RunCompletedPayload,
    RunFailedPayload,
    RunFinalizingPayload,
    RunInterruptedPayload,
    RunQueuedPayload,
    RunRecord,
    RunStartedPayload,
    RunStatus,
    TaskSnapshot,
)


_STATUS_PAYLOADS = {
    RunStartedPayload: RunStatus.RUNNING,
    RunFinalizingPayload: RunStatus.FINALIZING,
    RunCompletedPayload: RunStatus.COMPLETED,
    RunFailedPayload: RunStatus.FAILED,
    RunCancelRequestedPayload: RunStatus.CANCEL_REQUESTED,
    RunCancelledPayload: RunStatus.CANCELLED,
    RunInterruptedPayload: RunStatus.INTERRUPTED,
}

_TERMINAL_STATUSES = {
    RunStatus.COMPLETED,
    RunStatus.FAILED,
    RunStatus.CANCELLED,
    RunStatus.INTERRUPTED,
}

_LEGAL_TRANSITIONS = {
    RunStatus.QUEUED: {RunStatus.RUNNING, RunStatus.CANCEL_REQUESTED},
    RunStatus.RUNNING: {
        RunStatus.FINALIZING,
        RunStatus.CANCEL_REQUESTED,
        RunStatus.FAILED,
        RunStatus.INTERRUPTED,
    },
    RunStatus.FINALIZING: {
        RunStatus.COMPLETED,
        RunStatus.CANCEL_REQUESTED,
        RunStatus.FAILED,
        RunStatus.INTERRUPTED,
    },
    RunStatus.CANCEL_REQUESTED: {
        RunStatus.CANCELLED,
        RunStatus.INTERRUPTED,
    },
    RunStatus.COMPLETED: set(),
    RunStatus.FAILED: set(),
    RunStatus.CANCELLED: set(),
    RunStatus.INTERRUPTED: set(),
}


def _run_index(snapshot: TaskSnapshot, run_id: str) -> int:
    for index, run in enumerate(snapshot.runs):
        if run.run_id == run_id:
            return index
    raise ValueError(f"unknown run_id: {run_id}")


def reduce_task_event(
    snapshot: TaskSnapshot,
    event: EventEnvelope,
) -> TaskSnapshot:
    """Return a new task snapshot with one persisted event applied."""

    if event.task_id != snapshot.task.task_id:
        raise ValueError("event task_id must match snapshot task_id")
    if event.sequence <= snapshot.task.latest_sequence:
        raise ValueError("event sequence must be task-local and strictly increasing")

    runs = list(snapshot.runs)
    payload = event.payload

    if isinstance(payload, RunQueuedPayload):
        if event.run_id is None:
            raise ValueError("run-scoped events require run_id")
        if any(run.run_id == event.run_id for run in snapshot.runs):
            raise ValueError(f"run_id already exists: {event.run_id}")
        if any(run.status not in _TERMINAL_STATUSES for run in snapshot.runs):
            raise ValueError("cannot queue a run while another active run exists")
        runs.append(
            RunRecord(
                run_id=event.run_id,
                task_id=event.task_id,
                request_id=payload.request_id,
                status=RunStatus.QUEUED,
                input=payload.input,
                created_at=event.timestamp,
                updated_at=event.timestamp,
            )
        )
        status = RunStatus.QUEUED
    elif type(payload) in _STATUS_PAYLOADS:
        if event.run_id is None:
            raise ValueError("run-scoped events require run_id")
        index = _run_index(snapshot, event.run_id)
        status = _STATUS_PAYLOADS[type(payload)]
        current_status = runs[index].status
        if current_status in _TERMINAL_STATUSES:
            raise ValueError(f"terminal run is immutable: {event.run_id}")
        if status not in _LEGAL_TRANSITIONS[current_status]:
            raise ValueError(
                f"illegal run status transition: {current_status} -> {status}"
            )
        updates: dict[str, object] = {
            "status": status,
            "updated_at": event.timestamp,
        }
        if status is RunStatus.RUNNING:
            updates["started_at"] = event.timestamp
        if status in _TERMINAL_STATUSES:
            updates["finished_at"] = event.timestamp
        if isinstance(payload, RunFailedPayload):
            updates["error"] = payload.error
        runs[index] = RunRecord.model_validate(
            runs[index].model_dump() | updates
        )
    elif event.run_id is not None:
        index = _run_index(snapshot, event.run_id)
        if runs[index].status in _TERMINAL_STATUSES:
            raise ValueError(f"terminal run is immutable: {event.run_id}")
        status = snapshot.task.status
    else:
        status = snapshot.task.status

    active_run_id = snapshot.task.active_run_id
    if isinstance(payload, RunQueuedPayload) or type(payload) in _STATUS_PAYLOADS:
        active_run_id = None if status in _TERMINAL_STATUSES else event.run_id

    task = snapshot.task.model_copy(
        update={
            "status": status,
            "active_run_id": active_run_id,
            "updated_at": event.timestamp,
            "latest_sequence": event.sequence,
        }
    )
    return snapshot.model_copy(update={"task": task, "runs": runs})
