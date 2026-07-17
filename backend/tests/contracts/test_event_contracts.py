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
    StageStartedPayload,
    TaskCreatedPayload,
    ToolCalledPayload,
    build_event,
)
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
