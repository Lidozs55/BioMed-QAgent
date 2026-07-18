from __future__ import annotations

import re
from datetime import UTC, datetime

import pytest
from app.domain.contracts import (
    AttemptStatus,
    ErrorCode,
    ErrorDetail,
    EventEnvelope,
    PipelineEventType,
    StageCompletedPayload,
    StageFailedPayload,
    StageName,
    StageProgressPayload,
    StageStartedPayload,
    TaskCreatedPayload,
    ToolCalledPayload,
    build_event,
)
from app.domain.contracts.events import _STAGE_EVENTS
from pydantic import ValidationError

NOW = datetime(2026, 7, 12, tzinfo=UTC)
SHA256 = "aa" * 32


def test_pipeline_event_enum_contains_every_mandatory_type() -> None:
    assert {event.value for event in PipelineEventType} == {
        "task_created",
        "plan_ready",
        "user_input_required",
        "user_input_resumed",
        "stage_started",
        "stage_completed",
        "stage_failed",
        "stage_skipped",
        "stage_progress",
        "tool_called",
        "tool_completed",
        "warning",
        "artifact_produced",
        "task_cancel_requested",
        "task_cancelled",
        "task_recovered",
        "task_completed",
        "task_failed",
    }


def test_build_event_generates_uuid4_id_and_preserves_sequence() -> None:
    event = build_event(
        task_id="task_1",
        sequence=1,
        payload=TaskCreatedPayload(topic="breast cancer"),
        timestamp=NOW,
    )

    assert event.type is PipelineEventType.TASK_CREATED
    assert event.sequence == 1
    assert re.fullmatch(
        r"event_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-"
        r"[89ab][0-9a-f]{3}-[0-9a-f]{12}",
        event.event_id,
    )


def test_event_envelope_rejects_payload_that_does_not_match_type() -> None:
    with pytest.raises(ValidationError, match="must match payload type"):
        EventEnvelope(
            event_id="event_123",
            type=PipelineEventType.TOOL_CALLED,
            task_id="task_1",
            sequence=1,
            timestamp=NOW,
            payload=TaskCreatedPayload(topic="breast cancer"),
        )


def test_event_envelope_rejects_non_positive_sequence() -> None:
    with pytest.raises(ValidationError):
        build_event(
            task_id="task_1",
            sequence=0,
            payload=TaskCreatedPayload(topic="test"),
            timestamp=NOW,
        )


def test_stage_events_require_stage_attempt_linkage() -> None:
    payload = StageStartedPayload(
        stage=StageName.ACQUISITION,
        attempt=1,
    )

    with pytest.raises(ValidationError, match="stage_attempt_id"):
        build_event(
            task_id="task_1",
            sequence=1,
            payload=payload,
            timestamp=NOW,
        )


def test_discriminated_payloads_keep_stage_outcomes_structured() -> None:
    completed = StageCompletedPayload(
        stage=StageName.PROCESSING,
        status=AttemptStatus.SUCCEEDED,
        output_digest=SHA256,
    )
    failed = StageFailedPayload(
        stage=StageName.ACQUISITION,
        status=AttemptStatus.FAILED,
        error=ErrorDetail(
            code=ErrorCode.NETWORK_ERROR,
            message="network unavailable",
            retryable=True,
            stage=StageName.ACQUISITION,
        ),
    )

    assert completed.type is PipelineEventType.STAGE_COMPLETED
    assert failed.error.code is ErrorCode.NETWORK_ERROR


def test_payload_discriminator_rejects_unknown_payload_shape() -> None:
    with pytest.raises(ValidationError):
        EventEnvelope(
            event_id="event_123",
            type=PipelineEventType.TOOL_CALLED,
            task_id="task_1",
            sequence=1,
            timestamp=NOW,
            payload={"type": "tool_called", "missing_tool_name": "x"},
        )

    assert ToolCalledPayload(tool_name="search_geo", arguments_digest=SHA256).type \
        is PipelineEventType.TOOL_CALLED


def test_stage_progress_payload_is_not_stage_attempt_scoped() -> None:
    """StageProgressPayload must NOT require stage_attempt_id.

    In Agent mode Skills emit progress through RunContext.emit_progress with
    no stage_attempt_id (the agent loop has no notion of stage attempts).
    Adding STAGE_PROGRESS to _STAGE_EVENTS would force the EventEnvelope
    validator to reject those events. See docs/REVIEW_2026-07-18.md §4.
    """
    assert PipelineEventType.STAGE_PROGRESS not in _STAGE_EVENTS

    event = build_event(
        task_id="task_1",
        sequence=1,
        payload=StageProgressPayload(
            stage=StageName.DISCOVERY,
            kind="discovered_records",
            current=2,
            total=2,
            detail={"source": "ncbi"},
        ),
        timestamp=NOW,
    )
    assert event.stage_attempt_id is None


def test_stage_progress_payload_enforces_field_constraints() -> None:
    with pytest.raises(ValidationError):
        StageProgressPayload(
            stage=StageName.DISCOVERY,
            kind="",  # min_length=1
            current=0,
        )
    with pytest.raises(ValidationError):
        StageProgressPayload(
            stage=StageName.DISCOVERY,
            kind="ok",
            current=-1,  # ge=0
        )
    with pytest.raises(ValidationError):
        StageProgressPayload(
            stage=StageName.DISCOVERY,
            kind="ok",
            current=0,
            total=-1,  # ge=0
        )


def test_stage_progress_payload_defaults_total_and_detail() -> None:
    payload = StageProgressPayload(
        stage=StageName.PROCESSING,
        kind="cleaned_rows",
        current=4821,
    )
    assert payload.total is None
    assert payload.detail == {}
