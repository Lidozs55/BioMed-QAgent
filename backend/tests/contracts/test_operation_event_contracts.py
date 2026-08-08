"""Operation-event contract: round-trip, legacy replay, and stage mapping.

T3 (Phase 7): the pipeline ``stage_*`` stream is mirrored by generic
operation events carrying ``operation_id`` / ``label`` / ``category`` so the
frontend can render by operation identity instead of the fixed ``StageName``
union (ARCHITECTURE §14.2 / §17.2). The ``label`` / ``category`` fields on
``operation_progress`` / ``operation_completed`` / ``operation_failed`` are
optional so pre-T3 events.jsonl and the V2 executor's emissions replay
unchanged (Global Constraints: old events replay correctly).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from app.domain.contracts import (
    AttemptStatus,
    ErrorCode,
    ErrorDetail,
    OperationCompletedPayload,
    OperationFailedPayload,
    OperationProgressPayload,
    OperationStartedPayload,
    RunQueuedPayload,
    RunStatus,
    StageName,
    TaskMode,
    TaskSnapshot,
    TaskSummary,
    build_event,
    stage_operation_spec,
)
from app.runtime.state import reduce_task_event
from pydantic import ValidationError

NOW = datetime(2026, 7, 13, tzinfo=UTC)
SHA256 = "ab" * 32


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


def test_operation_payloads_round_trip_label_and_category() -> None:
    started = OperationStartedPayload(
        operation_id="stage:discovery",
        label="文献/数据发现",
        category="discovery",
        attempt=1,
    )
    progress = OperationProgressPayload(
        operation_id="stage:discovery",
        label="文献/数据发现",
        category="discovery",
        kind="discovered_records",
        current=3,
        total=10,
        detail={"source": "pubmed"},
    )
    completed = OperationCompletedPayload(
        operation_id="stage:discovery",
        label="文献/数据发现",
        category="discovery",
        output_digest=SHA256,
    )
    failed = OperationFailedPayload(
        operation_id="stage:processing",
        label="数据处理",
        category="processing",
        status=AttemptStatus.FAILED,
        error=ErrorDetail(
            code=ErrorCode.PARSE_ERROR,
            message="boom",
            retryable=False,
        ),
    )

    for payload in (started, progress, completed, failed):
        restored = type(payload).model_validate(payload.model_dump(mode="json"))
        assert restored == payload
        assert restored.label == payload.label
        assert restored.category == payload.category


def test_operation_payloads_tolerate_legacy_missing_label_and_category() -> None:
    """Pre-T3 payloads omit label/category; they must default to empty."""

    progress = OperationProgressPayload(
        operation_id="acquire:src", kind="download", current=1, total=2
    )
    completed = OperationCompletedPayload(operation_id="acquire:src", output_digest=SHA256)
    failed = OperationFailedPayload(
        operation_id="acquire:src",
        status=AttemptStatus.FAILED,
        error=ErrorDetail(
            code=ErrorCode.INTERNAL_ERROR,
            message="boom",
            retryable=False,
        ),
    )

    assert progress.label == ""
    assert progress.category == ""
    assert completed.label == ""
    assert completed.category == ""
    assert failed.label == ""
    assert failed.category == ""


def test_stage_operation_spec_is_stable_and_categorical() -> None:
    """stage_operation_spec maps every StageName to a stable (id, label, category)."""

    assert stage_operation_spec(StageName.DISCOVERY) == (
        "stage:discovery",
        "文献/数据发现",
        "discovery",
    )
    assert stage_operation_spec(StageName.ACQUISITION) == (
        "stage:acquisition",
        "数据获取",
        "acquisition",
    )
    assert stage_operation_spec(StageName.PROCESSING) == (
        "stage:processing",
        "数据处理",
        "processing",
    )
    assert stage_operation_spec(StageName.ARTIFACT_BUILD) == (
        "stage:artifact_build",
        "产物构建",
        "artifact_build",
    )
    assert stage_operation_spec(StageName.VALIDATION) == (
        "stage:validation",
        "结果验证",
        "validation",
    )
    # Every stage maps to a distinct stable operation id (UI grouping key).
    ids = {stage_operation_spec(stage)[0] for stage in StageName}
    assert len(ids) == len(StageName)


def test_operation_events_require_run_linkage() -> None:
    """RuntimeEventType operation events require run_id + schema 2.0."""

    with pytest.raises(ValidationError, match="schema_version 2.0"):
        build_event(
            task_id="task_123",
            sequence=1,
            payload=OperationStartedPayload(
                operation_id="stage:discovery",
                label="文献/数据发现",
                category="discovery",
                attempt=1,
            ),
            timestamp=NOW,
        )


def test_legacy_operation_events_replay_through_reducer() -> None:
    """Pre-T3 operation events (no label/category) replay through the reducer."""

    snapshot = reduce_task_event(
        empty_snapshot(),
        build_event(
            task_id="task_123",
            run_id="run_123",
            sequence=1,
            timestamp=NOW,
            payload=RunQueuedPayload(request_id="req_123", input="question"),
        ),
    )
    legacy_payloads = [
        OperationStartedPayload(operation_id="stage:discovery", attempt=1),
        OperationProgressPayload(
            operation_id="stage:discovery",
            kind="discovered_records",
            current=1,
            total=5,
        ),
        OperationCompletedPayload(operation_id="stage:discovery", output_digest=SHA256),
    ]
    for sequence, payload in enumerate(legacy_payloads, start=2):
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

    assert snapshot.task.latest_sequence == 4
    assert snapshot.runs[0].status is RunStatus.QUEUED
