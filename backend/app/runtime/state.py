"""Pure projection of persisted events into authoritative task state."""

from __future__ import annotations

from collections.abc import Iterable

from app.domain.contracts import (
    ArtifactProducedPayload,
    EventEnvelope,
    PublicationCreatedPayload,
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
from app.domain.contracts.runtime import PublicationSummary, RunSummary

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
    publications = list(snapshot.publications)
    current_publication_id = snapshot.current_publication_id
    payload = event.payload
    # A8: copy the private seen-artifact map so the returned snapshot never
    # aliases (or mutates) the input snapshot's bookkeeping.
    seen_artifact_ids = {
        run_id: set(ids) for run_id, ids in snapshot._artifact_ids_by_run.items()
    }
    # H6: copy the first-occurrence fingerprints for conflicting-duplicate
    # detection (same shape, also never aliased/mutated).
    artifact_fingerprints = {
        run_id: {artifact_id: fingerprint for artifact_id, fingerprint in fps.items()}
        for run_id, fps in snapshot._artifact_fingerprints_by_run.items()
    }

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
    elif isinstance(payload, PublicationCreatedPayload):
        if event.run_id is None:
            raise ValueError("publication events require run_id")
        if payload.run_id != event.run_id:
            raise ValueError("payload run_id must match envelope run_id")
        _run_index(snapshot, event.run_id)
        existing = next(
            (
                item
                for item in publications
                if item.publication_id == payload.publication_id
            ),
            None,
        )
        if existing is None:
            previous = current_publication_id
            publications.append(
                PublicationSummary(
                    publication_id=payload.publication_id,
                    manifest_sha256=payload.manifest_sha256,
                    supersedes_publication_id=(
                        payload.supersedes_publication_id or previous
                    ),
                    published_at=payload.published_at,
                )
            )
            current_publication_id = payload.publication_id
        elif (
            existing.manifest_sha256 != payload.manifest_sha256
            or existing.published_at != payload.published_at
        ):
            raise ValueError(
                f"conflicting duplicate publication event: "
                f"{payload.publication_id}"
            )
        # Identical duplicate (same sha256 and published_at): no-op.
        # supersedes_publication_id is state-derived, not compared.
        status = snapshot.task.status
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
        summary = _run_summary_for(payload, status)
        if summary is not None:
            updates["summary"] = summary
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
        # A8 (Phase 4 review): dedup artifact identities per run so a retry or
        # reconciliation path that re-appends the same artifact payload at a
        # new task sequence cannot inflate the count. Events without a run_id
        # (not produced today) keep the legacy unconditional counting.
        if event.run_id is not None:
            run_seen = seen_artifact_ids.setdefault(event.run_id, set())
            artifact_id = payload.artifact.artifact_id
            if artifact_id not in run_seen:
                run_seen.add(artifact_id)
                artifact_count += 1
                artifact_fingerprints.setdefault(event.run_id, {})[artifact_id] = (
                    payload.artifact.sha256,
                    payload.artifact.relative_path,
                )
            else:
                # H6 (Phase 4 review): a duplicate identity whose digest/path
                # conflicts with the first occurrence is a conflicting
                # duplicate and is rejected, mirroring the publication
                # duplicate handling; an identical replay stays a no-op.
                first = artifact_fingerprints.get(event.run_id, {}).get(artifact_id)
                if first is not None and (
                    payload.artifact.sha256 != first[0]
                    or payload.artifact.relative_path != first[1]
                ):
                    raise ValueError(
                        f"conflicting duplicate artifact event: {artifact_id}"
                    )
        else:
            artifact_count += 1

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
        }
    )
    updated = snapshot.model_copy(
        update={
            "task": task,
            "runs": runs,
            "subagents": subagents,
            "publications": publications,
            "current_publication_id": current_publication_id,
        }
    )
    updated._artifact_ids_by_run = seen_artifact_ids
    updated._artifact_fingerprints_by_run = artifact_fingerprints
    return updated


def _run_summary_for(
    payload: object, status: RunStatus
) -> RunSummary | None:
    """Project a server-generated per-run outcome summary from a terminal event.

    Partial projection is legal: legacy events may lack ``build_result``
    (RunCompletedPayload) or ``error_code`` (RunFailedPayload).
    """

    if isinstance(payload, RunCompletedPayload):
        return RunSummary(
            run_status=status,
            build_result=payload.build_result,
            user_message=(
                payload.build_result.user_summary
                if payload.build_result is not None
                else None
            ),
        )
    if isinstance(payload, RunFailedPayload):
        return RunSummary(
            run_status=status,
            error_code=payload.error_code,
            user_message=payload.error,
        )
    if isinstance(payload, RunCancelledPayload):
        return RunSummary(
            run_status=status,
            cancelled_at_stage=payload.cancelled_at_stage,
            user_message=payload.reason,
        )
    if isinstance(payload, RunInterruptedPayload):
        return RunSummary(run_status=status, user_message=payload.reason)
    return None


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


def artifact_identities_from_events(
    events: Iterable[EventEnvelope],
    *,
    through_sequence: int | None = None,
) -> tuple[dict[str, set[str]], dict[str, dict[str, tuple[str, str]]]]:
    """Rebuild the artifact dedup state from artifact_produced events (H6).

    Used when loading a snapshot whose private dedup key is missing (e.g. a
    pre-fix snapshot that already carries ``artifact_count``) so replaying an
    old duplicate after upgrade cannot over-count and conflicting duplicates
    are still detected. Returns ``(seen_ids_by_run, fingerprints_by_run)``
    matching the reducer's per-run bookkeeping.
    """

    ids_by_run: dict[str, set[str]] = {}
    fingerprints: dict[str, dict[str, tuple[str, str]]] = {}
    for event in events:
        if through_sequence is not None and event.sequence > through_sequence:
            continue
        if event.run_id is None:
            continue
        payload = event.payload
        if not isinstance(payload, ArtifactProducedPayload):
            continue
        artifact_id = payload.artifact.artifact_id
        ids_by_run.setdefault(event.run_id, set()).add(artifact_id)
        fingerprints.setdefault(event.run_id, {}).setdefault(
            artifact_id,
            (payload.artifact.sha256, payload.artifact.relative_path),
        )
    return ids_by_run, fingerprints
