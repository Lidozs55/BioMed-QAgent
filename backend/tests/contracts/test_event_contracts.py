from __future__ import annotations

import importlib
import re
from datetime import UTC, datetime

import pytest
from app.datasets.contracts import BuildResult, BuildResultStatus
from app.domain.contracts import (
    AssistantDeltaPayload,
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
    TaskCreatedPayload,
    ToolCalledPayload,
    build_event,
)
from app.domain.contracts.events import (
    _STAGE_EVENTS,
    PublicationCreatedPayload,
    RunCancelledPayload,
    RunCompletedPayload,
    RunFailedPayload,
)
from pydantic import TypeAdapter, ValidationError

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


def test_assistant_delta_legacy_shape_keeps_optional_stream_metadata_null() -> None:
    payload = AssistantDeltaPayload(delta="legacy")

    assert payload.model_dump() == {
        "schema_version": "1.0",
        "type": "assistant_delta",
        "delta": "legacy",
        "stream_id": None,
        "from_chunk_index": None,
        "through_chunk_index": None,
    }


@pytest.mark.parametrize(
    ("values", "message"),
    [
        ({"stream_id": "stream_1"}, "all be provided"),
        (
            {
                "stream_id": "",
                "from_chunk_index": 0,
                "through_chunk_index": 0,
            },
            "at least 1 character",
        ),
        (
            {
                "stream_id": "stream_1",
                "from_chunk_index": -1,
                "through_chunk_index": 0,
            },
            "greater than or equal to 0",
        ),
        (
            {
                "stream_id": "stream_1",
                "from_chunk_index": 2,
                "through_chunk_index": 1,
            },
            "through_chunk_index",
        ),
    ],
)
def test_assistant_delta_stream_metadata_is_validated_all_or_none(
    values: dict[str, object],
    message: str,
) -> None:
    with pytest.raises(ValidationError, match=message):
        AssistantDeltaPayload(delta="text", **values)


def test_assistant_delta_accepts_a_complete_chunk_range() -> None:
    payload = AssistantDeltaPayload(
        delta="batched",
        stream_id="stream_1",
        from_chunk_index=2,
        through_chunk_index=4,
    )

    assert payload.stream_id == "stream_1"
    assert payload.from_chunk_index == 2
    assert payload.through_chunk_index == 4


@pytest.mark.parametrize(
    "frame_name, values",
    [
        (
            "AssistantStreamDeltaFrame",
            {
                "type": "assistant_stream_delta",
                "task_id": "task_1",
                "run_id": "run_1",
                "stream_id": "stream_1",
                "chunk_index": 0,
                "delta": "chunk",
            },
        ),
        (
            "AssistantStreamEndFrame",
            {
                "type": "assistant_stream_end",
                "task_id": "task_1",
                "run_id": "run_1",
                "stream_id": "stream_1",
                "last_chunk_index": None,
                "finish_reason": "stop",
            },
        ),
    ],
)
def test_assistant_stream_frames_have_only_the_strict_server_frame_shape(
    frame_name: str,
    values: dict[str, object],
) -> None:
    contracts = importlib.import_module("app.domain.contracts")
    frame_type = getattr(contracts, frame_name)

    frame = frame_type.model_validate(values)

    assert frame.model_dump(mode="json") == values
    with pytest.raises(ValidationError):
        frame_type.model_validate({**values, "unexpected": True})


@pytest.mark.parametrize(
    "frame_name, invalid_update",
    [
        ("AssistantStreamDeltaFrame", {"task_id": ""}),
        ("AssistantStreamDeltaFrame", {"run_id": ""}),
        ("AssistantStreamDeltaFrame", {"stream_id": ""}),
        ("AssistantStreamDeltaFrame", {"chunk_index": -1}),
        ("AssistantStreamDeltaFrame", {"chunk_index": "0"}),
        ("AssistantStreamDeltaFrame", {"delta": ""}),
        ("AssistantStreamEndFrame", {"last_chunk_index": -1}),
        ("AssistantStreamEndFrame", {"last_chunk_index": "0"}),
        ("AssistantStreamEndFrame", {"finish_reason": ""}),
    ],
)
def test_assistant_stream_frames_reject_invalid_or_coerced_fields(
    frame_name: str,
    invalid_update: dict[str, object],
) -> None:
    contracts = importlib.import_module("app.domain.contracts")
    frame_type = getattr(contracts, frame_name)
    valid_values: dict[str, object]
    if frame_name == "AssistantStreamDeltaFrame":
        valid_values = {
            "type": "assistant_stream_delta",
            "task_id": "task_1",
            "run_id": "run_1",
            "stream_id": "stream_1",
            "chunk_index": 0,
            "delta": "chunk",
        }
    else:
        valid_values = {
            "type": "assistant_stream_end",
            "task_id": "task_1",
            "run_id": "run_1",
            "stream_id": "stream_1",
            "last_chunk_index": 0,
            "finish_reason": "stop",
        }

    with pytest.raises(ValidationError):
        frame_type.model_validate({**valid_values, **invalid_update})


def test_assistant_stream_union_is_discriminated_and_not_an_event_payload() -> None:
    contracts = importlib.import_module("app.domain.contracts")
    frame = TypeAdapter(contracts.AssistantStreamFrame).validate_python(
        {
            "type": "assistant_stream_delta",
            "task_id": "task_1",
            "run_id": "run_1",
            "stream_id": "stream_1",
            "chunk_index": 0,
            "delta": "chunk",
        }
    )

    assert isinstance(frame, contracts.AssistantStreamDeltaFrame)
    with pytest.raises(ValidationError):
        build_event(task_id="task_1", run_id="run_1", sequence=1, payload=frame)


def test_subagent_events_require_complete_matching_v2_linkage() -> None:
    payload = SubagentQueuedPayload(
        subagent_id="subagent_123",
        request=SubagentRequest(
            agent_type=SubagentType.SOURCE_RESEARCH,
            objective="Find expression datasets",
            domain="bioinformatics",
            capability="source_research",
            inputs={"gene": "TP53"},
        ),
    )

    event = build_event(
        task_id="task_1",
        run_id="run_1",
        sequence=1,
        payload=payload,
        subagent_id="subagent_123",
        parent_tool_call_id="call_123",
        timestamp=NOW,
    )

    assert event.schema_version == "2.0"
    assert event.subagent_id == payload.subagent_id
    assert event.parent_tool_call_id == "call_123"

    with pytest.raises(ValidationError, match="both envelope linkage fields"):
        build_event(
            task_id="task_1",
            run_id="run_1",
            sequence=2,
            payload=payload,
            subagent_id="subagent_123",
            timestamp=NOW,
        )
    with pytest.raises(ValidationError, match="must match envelope.subagent_id"):
        build_event(
            task_id="task_1",
            run_id="run_1",
            sequence=3,
            payload=payload,
            subagent_id="subagent_other",
            parent_tool_call_id="call_123",
            timestamp=NOW,
        )


def test_subagent_payloads_are_discriminated_and_round_trip() -> None:
    result = SubagentResult(
        subagent_id="subagent_123",
        status=SubagentStatus.COMPLETED,
        summary="Found two datasets",
        source_asset_ids=["asset_1"],
    )
    payloads = [
        SubagentQueuedPayload(
            subagent_id="subagent_123",
            request=SubagentRequest(
                agent_type=SubagentType.SOURCE_RESEARCH,
                objective="Find datasets",
                domain="bioinformatics",
                capability="source_research",
                inputs={},
            ),
        ),
        SubagentStartedPayload(subagent_id="subagent_123"),
        SubagentProgressPayload(
            subagent_id="subagent_123",
            current=1,
            total=2,
            message="Inspecting GEO",
        ),
        SubagentCompletedPayload(subagent_id="subagent_123", result=result),
        SubagentFailedPayload(
            subagent_id="subagent_123",
            result=SubagentResult(
                subagent_id="subagent_123",
                status=SubagentStatus.FAILED,
                summary="Search failed",
            ),
        ),
        SubagentCancelRequestedPayload(subagent_id="subagent_123"),
        SubagentCancelledPayload(
            subagent_id="subagent_123",
            result=SubagentResult(
                subagent_id="subagent_123",
                status=SubagentStatus.CANCELLED,
                summary="Cancelled",
            ),
        ),
        SubagentInterruptedPayload(
            subagent_id="subagent_123",
            result=SubagentResult(
                subagent_id="subagent_123",
                status=SubagentStatus.INTERRUPTED,
                summary="Interrupted",
            ),
        ),
        SubagentInputRequiredPayload(
            subagent_id="subagent_123",
            request_id="request_123",
            summary="Credentials required",
            prompt_kind="api_key_or_credential",
            expires_at=NOW,
            detail={"source": "GEO"},
        ),
        SubagentInputResumedPayload(
            subagent_id="subagent_123",
            request_id="request_123",
            decision="approve",
            detail={"source": "GEO"},
        ),
    ]

    for sequence, payload in enumerate(payloads, start=1):
        event = build_event(
            task_id="task_1",
            run_id="run_1",
            sequence=sequence,
            payload=payload,
            subagent_id="subagent_123",
            parent_tool_call_id="call_123",
            timestamp=NOW,
        )
        parsed = EventEnvelope.model_validate_json(event.model_dump_json())
        assert type(parsed.payload) is type(payload)


@pytest.mark.parametrize(
    ("payload_type", "values"),
    [
        (
            SubagentInputRequiredPayload,
            {
                "subagent_id": "subagent_123",
                "request_id": "request_123",
                "summary": "Credentials required",
                "prompt_kind": "api_key_or_credential",
                "expires_at": NOW,
                "detail": {"source": "GEO"},
            },
        ),
        (
            SubagentInputResumedPayload,
            {
                "subagent_id": "subagent_123",
                "request_id": "request_123",
                "decision": "approve",
                "detail": {"source": "GEO"},
            },
        ),
    ],
)
def test_subagent_hil_payloads_round_trip_and_forbid_extra_fields(
    payload_type: type[SubagentInputRequiredPayload | SubagentInputResumedPayload],
    values: dict[str, object],
) -> None:
    payload = payload_type.model_validate(values)

    assert payload_type.model_validate_json(payload.model_dump_json()) == payload
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        payload_type.model_validate({**values, "unexpected": True})


def test_subagent_hil_payloads_default_empty_detail() -> None:
    required = SubagentInputRequiredPayload(
        subagent_id="subagent_123",
        request_id="request_123",
        summary="Confirm source terms",
        prompt_kind="terms_approval",
    )
    resumed = SubagentInputResumedPayload(
        subagent_id="subagent_123",
        request_id="request_123",
        decision="approve",
    )

    assert required.expires_at is None
    assert required.detail == {}
    assert resumed.detail == {}


@pytest.mark.parametrize(
    ("payload_type", "expected_status", "other_status"),
    [
        (
            SubagentCompletedPayload,
            SubagentStatus.COMPLETED,
            SubagentStatus.FAILED,
        ),
        (
            SubagentFailedPayload,
            SubagentStatus.FAILED,
            SubagentStatus.CANCELLED,
        ),
        (
            SubagentCancelledPayload,
            SubagentStatus.CANCELLED,
            SubagentStatus.INTERRUPTED,
        ),
        (
            SubagentInterruptedPayload,
            SubagentStatus.INTERRUPTED,
            SubagentStatus.COMPLETED,
        ),
    ],
)
def test_subagent_terminal_payloads_require_matching_result(
    payload_type: type[
        SubagentCompletedPayload
        | SubagentFailedPayload
        | SubagentCancelledPayload
        | SubagentInterruptedPayload
    ],
    expected_status: SubagentStatus,
    other_status: SubagentStatus,
) -> None:
    with pytest.raises(ValidationError, match="subagent_id must match result"):
        payload_type(
            subagent_id="subagent_123",
            result=SubagentResult(
                subagent_id="subagent_other",
                status=expected_status,
                summary="Terminal result",
            ),
        )
    with pytest.raises(ValidationError, match="result status must match"):
        payload_type(
            subagent_id="subagent_123",
            result=SubagentResult(
                subagent_id="subagent_123",
                status=other_status,
                summary="Terminal result",
            ),
        )


def test_terminal_event_payloads_carry_structured_state() -> None:
    completed = RunCompletedPayload(
        build_result=BuildResult(
            status=BuildResultStatus.NO_DATA,
            valid_row_count=0,
            reason_codes=["no_primary_data"],
        )
    )
    assert completed.build_result.status is BuildResultStatus.NO_DATA
    # 旧事件重放兼容：字段缺省合法
    assert RunCompletedPayload().build_result is None
    failed = RunFailedPayload(error="boom", error_code=ErrorCode.TIMEOUT)
    assert failed.error_code is ErrorCode.TIMEOUT
    assert RunFailedPayload(error="boom").error_code is None
    cancelled = RunCancelledPayload(
        reason="user", cancelled_at_stage=StageName.PROCESSING
    )
    assert cancelled.cancelled_at_stage is StageName.PROCESSING
    assert RunCancelledPayload().cancelled_at_stage is None


def test_publication_created_payload() -> None:
    payload = PublicationCreatedPayload(
        publication_id="pub-run_1",
        run_id="run_1",
        manifest_sha256="a" * 64,
        published_at=datetime.now(UTC),
    )
    assert payload.type == "publication_created"
    assert payload.supersedes_publication_id is None
