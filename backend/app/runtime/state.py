"""Pure projection of persisted events into authoritative task state."""

from __future__ import annotations

from collections.abc import Iterable

from app.domain.contracts import (
    ArtifactProducedPayload,
    EventEnvelope,
    RunCancelledPayload,
    RunCancelRequestedPayload,
    RunCompletedPayload,
    RunFailedPayload,
    RunFinalizingPayload,
    RunInterruptedPayload,
    RunQueuedPayload,
    RunRecord,
    RunStartedPayload,
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
    SubagentRecord,
    SubagentStartedPayload,
    SubagentStatus,
    TaskSnapshot,
    UserInputRequiredPayload,
    UserInputResumedPayload,
)

_STATUS_PAYLOADS = {
    RunStartedPayload: RunStatus.RUNNING,
    RunFinalizingPayload: RunStatus.FINALIZING,
    RunCompletedPayload: RunStatus.COMPLETED,
    RunFailedPayload: RunStatus.FAILED,
    RunCancelRequestedPayload: RunStatus.CANCEL_REQUESTED,
    RunCancelledPayload: RunStatus.CANCELLED,
    RunInterruptedPayload: RunStatus.INTERRUPTED,
    UserInputRequiredPayload: RunStatus.AWAITING_USER_INPUT,
    UserInputResumedPayload: RunStatus.RUNNING,
}

_TERMINAL_STATUSES = {
    RunStatus.COMPLETED,
    RunStatus.FAILED,
    RunStatus.CANCELLED,
    RunStatus.INTERRUPTED,
}
NO_ARTIFACT_FAILURE_MARKERS = (
    "without producing any artifacts",
    "manifest missing or unchanged",
)

_LEGAL_TRANSITIONS = {
    RunStatus.QUEUED: {RunStatus.RUNNING, RunStatus.CANCEL_REQUESTED},
    RunStatus.RUNNING: {
        RunStatus.FINALIZING,
        RunStatus.CANCEL_REQUESTED,
        RunStatus.AWAITING_USER_INPUT,
        RunStatus.FAILED,
        RunStatus.INTERRUPTED,
    },
    RunStatus.AWAITING_USER_INPUT: {
        RunStatus.RUNNING,
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
        RunStatus.FAILED,
        RunStatus.INTERRUPTED,
    },
    RunStatus.COMPLETED: set(),
    RunStatus.FAILED: set(),
    RunStatus.CANCELLED: set(),
    RunStatus.INTERRUPTED: set(),
}

_SUBAGENT_TRANSITIONS: dict[SubagentStatus, frozenset[SubagentStatus]] = {
    SubagentStatus.QUEUED: frozenset(
        {
            SubagentStatus.RUNNING,
            SubagentStatus.CANCEL_REQUESTED,
            SubagentStatus.CANCELLED,
            SubagentStatus.INTERRUPTED,
        }
    ),
    SubagentStatus.RUNNING: frozenset(
        {
            SubagentStatus.COMPLETED,
            SubagentStatus.FAILED,
            SubagentStatus.CANCEL_REQUESTED,
            SubagentStatus.CANCELLED,
            SubagentStatus.INTERRUPTED,
        }
    ),
    SubagentStatus.CANCEL_REQUESTED: frozenset(
        {
            SubagentStatus.CANCELLED,
            SubagentStatus.COMPLETED,
            SubagentStatus.FAILED,
            SubagentStatus.INTERRUPTED,
        }
    ),
    SubagentStatus.COMPLETED: frozenset(),
    SubagentStatus.FAILED: frozenset(),
    SubagentStatus.CANCELLED: frozenset(),
    SubagentStatus.INTERRUPTED: frozenset(),
}

_SUBAGENT_TERMINAL_STATUSES = frozenset(
    {
        SubagentStatus.COMPLETED,
        SubagentStatus.FAILED,
        SubagentStatus.CANCELLED,
        SubagentStatus.INTERRUPTED,
    }
)

_SUBAGENT_STATUS_PAYLOADS = {
    SubagentStartedPayload: SubagentStatus.RUNNING,
    SubagentCancelRequestedPayload: SubagentStatus.CANCEL_REQUESTED,
}

_SUBAGENT_TERMINAL_PAYLOADS = (
    SubagentCompletedPayload,
    SubagentFailedPayload,
    SubagentCancelledPayload,
    SubagentInterruptedPayload,
)

_SUBAGENT_PAYLOADS = (
    SubagentStartedPayload,
    SubagentProgressPayload,
    *_SUBAGENT_TERMINAL_PAYLOADS,
    SubagentCancelRequestedPayload,
    SubagentInputRequiredPayload,
    SubagentInputResumedPayload,
)


def _run_index(snapshot: TaskSnapshot, run_id: str) -> int:
    for index, run in enumerate(snapshot.runs):
        if run.run_id == run_id:
            return index
    raise ValueError(f"unknown run_id: {run_id}")


def _subagent_index(snapshot: TaskSnapshot, subagent_id: str) -> int:
    for index, subagent in enumerate(snapshot.subagents):
        if subagent.subagent_id == subagent_id:
            return index
    raise ValueError(f"unknown subagent_id: {subagent_id}")


def _subagent_terminal_matches(
    record: SubagentRecord,
    payload: SubagentCompletedPayload
    | SubagentFailedPayload
    | SubagentCancelledPayload
    | SubagentInterruptedPayload,
) -> bool:
    result = payload.result
    return (
        record.status is result.status
        and record.result_summary == result.summary
        and record.source_asset_ids == result.source_asset_ids
        and record.recipe_id == result.recipe_id
        and record.error_code is result.error_code
        and record.error_message == result.error_message
    )


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
    subagents = list(snapshot.subagents)
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
                request_fingerprint=payload.request_fingerprint,
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
        # Only stamp started_at on a fresh RUNNING transition; a resume from
        # AWAITING_USER_INPUT preserves the original start time.
        if status is RunStatus.RUNNING and current_status is not RunStatus.AWAITING_USER_INPUT:
            updates["started_at"] = event.timestamp
        if status in _TERMINAL_STATUSES:
            updates["finished_at"] = event.timestamp
        if isinstance(payload, RunFailedPayload):
            updates["error"] = payload.error
        runs[index] = RunRecord.model_validate(
            runs[index].model_dump() | updates
        )
    elif isinstance(payload, SubagentQueuedPayload):
        if event.run_id is None or event.parent_tool_call_id is None:
            raise ValueError("subagent events require parent run linkage")
        _run_index(snapshot, event.run_id)
        if any(item.subagent_id == payload.subagent_id for item in subagents):
            raise ValueError(f"subagent_id already exists: {payload.subagent_id}")
        request = payload.request
        subagents.append(
            SubagentRecord(
                subagent_id=payload.subagent_id,
                task_id=event.task_id,
                run_id=event.run_id,
                agent_type=request.agent_type,
                objective=request.objective,
                target_source=request.target_source,
                status=SubagentStatus.QUEUED,
                parent_tool_call_id=event.parent_tool_call_id,
                created_at=event.timestamp,
                progress_current=0,
            )
        )
        status = snapshot.task.status
    elif isinstance(payload, _SUBAGENT_PAYLOADS):
        if event.run_id is None:
            raise ValueError("subagent events require parent run linkage")
        _run_index(snapshot, event.run_id)
        index = _subagent_index(snapshot, payload.subagent_id)
        record = subagents[index]
        if record.task_id != event.task_id:
            raise ValueError("subagent task_id must match event task_id")
        if record.run_id != event.run_id:
            raise ValueError("subagent run_id must match event run_id")

        if record.status in _SUBAGENT_TERMINAL_STATUSES:
            if isinstance(payload, _SUBAGENT_TERMINAL_PAYLOADS) and _subagent_terminal_matches(
                record, payload
            ):
                updates: dict[str, object] = {}
            else:
                raise ValueError(
                    "invalid subagent transition: "
                    f"terminal subagent is immutable: {record.subagent_id}"
                )
        elif type(payload) in _SUBAGENT_STATUS_PAYLOADS:
            next_status = _SUBAGENT_STATUS_PAYLOADS[type(payload)]
            if next_status not in _SUBAGENT_TRANSITIONS[record.status]:
                raise ValueError(
                    f"invalid subagent transition: {record.status} -> {next_status}"
                )
            updates = {"status": next_status}
            if next_status is SubagentStatus.RUNNING:
                updates["started_at"] = event.timestamp
        elif isinstance(payload, SubagentProgressPayload):
            updates = {
                "progress_current": payload.current,
                "progress_total": payload.total,
                "progress_message": payload.message,
            }
        elif isinstance(payload, SubagentInputRequiredPayload):
            if record.status is not SubagentStatus.RUNNING:
                raise ValueError("subagent input required is legal only while running")
            if record.pending_request_id not in {None, payload.request_id}:
                raise ValueError("subagent already has a pending input request")
            updates = {"pending_request_id": payload.request_id}
        elif isinstance(payload, SubagentInputResumedPayload):
            if record.status is not SubagentStatus.RUNNING:
                raise ValueError("subagent input resume is legal only while running")
            if record.pending_request_id != payload.request_id:
                raise ValueError("subagent has no matching pending input request")
            updates = {"pending_request_id": None}
        else:
            next_status = payload.result.status
            if next_status not in _SUBAGENT_TRANSITIONS[record.status]:
                raise ValueError(
                    f"invalid subagent transition: {record.status} -> {next_status}"
                )
            updates = {
                "status": next_status,
                "finished_at": event.timestamp,
                "result_summary": payload.result.summary,
                "source_asset_ids": payload.result.source_asset_ids,
                "recipe_id": payload.result.recipe_id,
                "error_code": payload.result.error_code,
                "error_message": payload.result.error_message,
                "pending_request_id": None,
            }
        subagents[index] = record.model_copy(update=updates)
        status = snapshot.task.status
    elif event.run_id is not None:
        index = _run_index(snapshot, event.run_id)
        if runs[index].status in _TERMINAL_STATUSES:
            raise ValueError(f"terminal run is immutable: {event.run_id}")
        status = snapshot.task.status
    else:
        status = snapshot.task.status

    artifact_count = snapshot.task.artifact_count
    if isinstance(payload, ArtifactProducedPayload):
        artifact_count += 1
    no_artifact_failure = no_artifact_failure_from_runs(runs)

    active_run_id = snapshot.task.active_run_id
    if isinstance(payload, RunQueuedPayload) or type(payload) in _STATUS_PAYLOADS:
        active_run_id = None if status in _TERMINAL_STATUSES else event.run_id

    task = snapshot.task.model_copy(
        update={
            "status": status,
            "active_run_id": active_run_id,
            "updated_at": event.timestamp,
            "latest_sequence": event.sequence,
            "artifact_count": artifact_count,
            "no_artifact_failure": no_artifact_failure,
        }
    )
    return snapshot.model_copy(
        update={"task": task, "runs": runs, "subagents": subagents}
    )


def no_artifact_failure_from_runs(runs: list[RunRecord]) -> bool:
    """True when the latest run failed with the no-artifact completion marker."""
    latest = runs[-1] if runs else None
    if (
        latest is None
        or latest.status is not RunStatus.FAILED
        or latest.error is None
    ):
        return False
    return any(marker in latest.error for marker in NO_ARTIFACT_FAILURE_MARKERS)


def count_artifact_produced_events(
    events: Iterable[EventEnvelope],
    *,
    through_sequence: int | None = None,
) -> int:
    """Count validated artifact events for legacy snapshot backfill."""
    return sum(
        1
        for event in events
        if isinstance(event.payload, ArtifactProducedPayload)
        and (through_sequence is None or event.sequence <= through_sequence)
    )
