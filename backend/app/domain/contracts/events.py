"""Typed event payloads and envelope for persistence and replay."""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, ClassVar, Literal, Self

from pydantic import Field, JsonValue, model_validator

from app.domain.contracts.base import ContractModel
from app.domain.contracts.dataset_state import BuildResult
from app.domain.contracts.enums import (
    AttemptStatus,
    ErrorCode,
    StageName,
    SubagentStatus,
)
from app.domain.contracts.ids import generate_prefixed_uuid
from app.domain.contracts.pipeline import (
    ArtifactManifestEntry,
    ErrorDetail,
    ValidationSummary,
    WarningRecord,
)
from app.domain.contracts.runtime import SubagentRequest, SubagentResult
from app.domain.contracts.task import TaskSpecification


class PipelineEventType(StrEnum):
    TASK_CREATED = "task_created"
    PLAN_READY = "plan_ready"
    USER_INPUT_REQUIRED = "user_input_required"
    USER_INPUT_RESUMED = "user_input_resumed"
    STAGE_STARTED = "stage_started"
    STAGE_COMPLETED = "stage_completed"
    STAGE_FAILED = "stage_failed"
    STAGE_SKIPPED = "stage_skipped"
    STAGE_PROGRESS = "stage_progress"
    TOOL_CALLED = "tool_called"
    TOOL_COMPLETED = "tool_completed"
    WARNING = "warning"
    ARTIFACT_PRODUCED = "artifact_produced"
    TASK_CANCEL_REQUESTED = "task_cancel_requested"
    TASK_CANCELLED = "task_cancelled"
    TASK_RECOVERED = "task_recovered"
    TASK_COMPLETED = "task_completed"
    TASK_FAILED = "task_failed"


class RuntimeEventType(StrEnum):
    RUN_QUEUED = "run_queued"
    RUN_STARTED = "run_started"
    RUN_FINALIZING = "run_finalizing"
    RUN_COMPLETED = "run_completed"
    RUN_FAILED = "run_failed"
    RUN_CANCEL_REQUESTED = "run_cancel_requested"
    RUN_CANCELLED = "run_cancelled"
    RUN_INTERRUPTED = "run_interrupted"
    PUBLICATION_CREATED = "publication_created"
    ASSISTANT_DELTA = "assistant_delta"
    ASSISTANT_REASONING_DELTA = "assistant_reasoning_delta"
    TOOL_STARTED = "tool_started"
    CONVERSATION_COMPACTED = "conversation_compacted"
    OPERATION_STARTED = "operation_started"
    OPERATION_PROGRESS = "operation_progress"
    OPERATION_COMPLETED = "operation_completed"
    OPERATION_FAILED = "operation_failed"
    SUBAGENT_QUEUED = "subagent_queued"
    SUBAGENT_STARTED = "subagent_started"
    SUBAGENT_PROGRESS = "subagent_progress"
    SUBAGENT_COMPLETED = "subagent_completed"
    SUBAGENT_FAILED = "subagent_failed"
    SUBAGENT_CANCEL_REQUESTED = "subagent_cancel_requested"
    SUBAGENT_CANCELLED = "subagent_cancelled"
    SUBAGENT_INTERRUPTED = "subagent_interrupted"
    SUBAGENT_INPUT_REQUIRED = "subagent_input_required"
    SUBAGENT_INPUT_RESUMED = "subagent_input_resumed"


class TaskCreatedPayload(ContractModel):
    type: Literal[PipelineEventType.TASK_CREATED] = PipelineEventType.TASK_CREATED
    topic: str = Field(min_length=1)


class PlanReadyPayload(ContractModel):
    type: Literal[PipelineEventType.PLAN_READY] = PipelineEventType.PLAN_READY
    specification: TaskSpecification


class StageStartedPayload(ContractModel):
    type: Literal[PipelineEventType.STAGE_STARTED] = PipelineEventType.STAGE_STARTED
    stage: StageName
    attempt: int = Field(ge=1)


class StageCompletedPayload(ContractModel):
    type: Literal[PipelineEventType.STAGE_COMPLETED] = PipelineEventType.STAGE_COMPLETED
    stage: StageName
    status: Literal[AttemptStatus.SUCCEEDED] = AttemptStatus.SUCCEEDED
    output_digest: str = Field(pattern=r"^[0-9a-f]{64}$")


class StageFailedPayload(ContractModel):
    type: Literal[PipelineEventType.STAGE_FAILED] = PipelineEventType.STAGE_FAILED
    stage: StageName
    status: Literal[AttemptStatus.FAILED] = AttemptStatus.FAILED
    error: ErrorDetail


class StageSkippedPayload(ContractModel):
    type: Literal[PipelineEventType.STAGE_SKIPPED] = PipelineEventType.STAGE_SKIPPED
    stage: StageName
    status: Literal[AttemptStatus.SKIPPED] = AttemptStatus.SKIPPED
    reason: str = Field(min_length=1)
    reused_stage_attempt_id: str | None = None


class StageProgressPayload(ContractModel):
    """Mid-stage progress update (records discovered, bytes downloaded, rows cleaned).

    Emitted by Skills (Agent mode via RunContext.emit_progress) or Pipeline
    stages (Pipeline mode via StageContext.emit_progress). Lets the frontend
    show concrete numbers ("found 23 papers", "cleaned 4821 rows") instead of
    only a single "running" stage badge. See docs/REVIEW_2026-07-18.md §4.
    """

    type: Literal[PipelineEventType.STAGE_PROGRESS] = (
        PipelineEventType.STAGE_PROGRESS
    )
    stage: StageName
    kind: str = Field(min_length=1)
    current: int = Field(ge=0)
    total: int | None = Field(default=None, ge=0)
    detail: dict[str, object] = Field(default_factory=dict)


class ToolCalledPayload(ContractModel):
    type: Literal[PipelineEventType.TOOL_CALLED] = PipelineEventType.TOOL_CALLED
    tool_name: str = Field(min_length=1)
    arguments_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    # REVIEW 2026-08-05 P3-1: 截断后的参数（深度受限），前端据此渲染
    # "检索 PubMed · 查询: ..." 等标签，无需回放 digest。
    arguments: dict[str, object] | None = Field(default=None)


class ToolCompletedPayload(ContractModel):
    type: Literal[PipelineEventType.TOOL_COMPLETED] = PipelineEventType.TOOL_COMPLETED
    tool_name: str = Field(min_length=1)
    output_digest: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    tool_call_id: str | None = Field(default=None, min_length=1)
    output: str | None = None
    is_error: bool = False

    @model_validator(mode="after")
    def validate_fixture_or_runtime_shape(self) -> Self:
        # REVIEW 2026-08-05 P1-3: 失败/取消路径补发 is_error=True 的 tool_completed
        # 以闭合事件流，此时既无 digest 也无 tool_call_id（pipeline 无 agent call id）。
        if not self.is_error and self.output_digest is None and self.tool_call_id is None:
            raise ValueError("tool completion requires output_digest or tool_call_id")
        return self


class WarningPayload(ContractModel):
    type: Literal[PipelineEventType.WARNING] = PipelineEventType.WARNING
    warning: WarningRecord | None = None
    message: str | None = Field(default=None, min_length=1)
    code: str | None = Field(default=None, min_length=1)

    @model_validator(mode="after")
    def validate_fixture_or_runtime_shape(self) -> Self:
        fixture_shape = self.warning is not None
        runtime_shape = self.message is not None and self.code is not None
        if fixture_shape == runtime_shape:
            raise ValueError("warning requires either warning record or message and code")
        return self


class ArtifactProducedPayload(ContractModel):
    type: Literal[PipelineEventType.ARTIFACT_PRODUCED] = (
        PipelineEventType.ARTIFACT_PRODUCED
    )
    artifact: ArtifactManifestEntry


class CancelRequestedPayload(ContractModel):
    type: Literal[PipelineEventType.TASK_CANCEL_REQUESTED] = (
        PipelineEventType.TASK_CANCEL_REQUESTED
    )
    reason: str | None = None


class TaskCancelledPayload(ContractModel):
    type: Literal[PipelineEventType.TASK_CANCELLED] = PipelineEventType.TASK_CANCELLED
    reason: str = Field(min_length=1)


class TaskRecoveredPayload(ContractModel):
    type: Literal[PipelineEventType.TASK_RECOVERED] = PipelineEventType.TASK_RECOVERED
    recovered_from_sequence: int = Field(ge=0)


class TaskCompletedPayload(ContractModel):
    type: Literal[PipelineEventType.TASK_COMPLETED] = PipelineEventType.TASK_COMPLETED
    validation: ValidationSummary
    build_result: BuildResult | None = Field(default=None)


class TaskFailedPayload(ContractModel):
    type: Literal[PipelineEventType.TASK_FAILED] = PipelineEventType.TASK_FAILED
    error: ErrorDetail


class RunQueuedPayload(ContractModel):
    type: Literal[RuntimeEventType.RUN_QUEUED] = RuntimeEventType.RUN_QUEUED
    request_id: str = Field(min_length=1)
    input: str = Field(min_length=1)
    request_fingerprint: str | None = Field(
        default=None,
        pattern=r"^[0-9a-f]{64}$",
    )


class RunStartedPayload(ContractModel):
    type: Literal[RuntimeEventType.RUN_STARTED] = RuntimeEventType.RUN_STARTED


class RunFinalizingPayload(ContractModel):
    type: Literal[RuntimeEventType.RUN_FINALIZING] = RuntimeEventType.RUN_FINALIZING


class RunCompletedPayload(ContractModel):
    type: Literal[RuntimeEventType.RUN_COMPLETED] = RuntimeEventType.RUN_COMPLETED
    build_result: BuildResult | None = Field(default=None)


class RunFailedPayload(ContractModel):
    type: Literal[RuntimeEventType.RUN_FAILED] = RuntimeEventType.RUN_FAILED
    error: str = Field(min_length=1)
    error_code: ErrorCode | None = Field(default=None)


class RunCancelRequestedPayload(ContractModel):
    type: Literal[RuntimeEventType.RUN_CANCEL_REQUESTED] = (
        RuntimeEventType.RUN_CANCEL_REQUESTED
    )
    reason: str | None = Field(default=None, min_length=1)


class RunCancelledPayload(ContractModel):
    type: Literal[RuntimeEventType.RUN_CANCELLED] = RuntimeEventType.RUN_CANCELLED
    reason: str | None = Field(default=None, min_length=1)
    cancelled_at_stage: StageName | None = Field(default=None)


class RunInterruptedPayload(ContractModel):
    type: Literal[RuntimeEventType.RUN_INTERRUPTED] = RuntimeEventType.RUN_INTERRUPTED
    reason: str = Field(min_length=1)


class PublicationCreatedPayload(ContractModel):
    """Immutable publication record appended to the event log (ARCHITECTURE §9.3).

    ``supersedes_publication_id`` is optional: the reducer derives the chain
    head from the task's prior ``current_publication_id`` when the field is
    absent, so the emit path never needs the current snapshot.
    """

    type: Literal[RuntimeEventType.PUBLICATION_CREATED] = (
        RuntimeEventType.PUBLICATION_CREATED
    )
    publication_id: str = Field(min_length=1)
    run_id: str = Field(min_length=1)
    manifest_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    supersedes_publication_id: str | None = Field(default=None, min_length=1)
    published_at: datetime


class UserInputRequiredPayload(ContractModel):
    """Unified human-in-the-loop pause request.

    The pipeline emits this payload when it needs a human decision before
    continuing. ``prompt_kind`` discriminates between plan confirmation
    (``plan_confirmation``), data correction (``data_correction``), and
    Agent max_turns exhaustion (``max_turns_reached``). When
    ``fixture_exempt`` is true the run is in fixture mode and the request is
    informational only — the pipeline auto-approves and does not block.
    """

    type: Literal[PipelineEventType.USER_INPUT_REQUIRED] = (
        PipelineEventType.USER_INPUT_REQUIRED
    )
    request_id: str = Field(min_length=1)
    prompt_kind: Literal[
        "plan_confirmation",
        "data_correction",
        "max_turns_reached",
        "no_progress",
    ]
    summary: str = Field(min_length=1)
    expires_at: datetime | None = None
    fixture_exempt: bool = False
    detail: dict[str, object] = Field(default_factory=dict)


class UserInputResumedPayload(ContractModel):
    """Resume decision submitted via ``POST /runs/{run_id}/resume``."""

    type: Literal[PipelineEventType.USER_INPUT_RESUMED] = (
        PipelineEventType.USER_INPUT_RESUMED
    )
    request_id: str = Field(min_length=1)
    decision: Literal["approve", "reject"]
    detail: dict[str, object] = Field(default_factory=dict)


class AssistantDeltaPayload(ContractModel):
    type: Literal[RuntimeEventType.ASSISTANT_DELTA] = (
        RuntimeEventType.ASSISTANT_DELTA
    )
    delta: str = Field(min_length=1)
    stream_id: str | None = Field(default=None, min_length=1)
    from_chunk_index: int | None = Field(default=None, ge=0, strict=True)
    through_chunk_index: int | None = Field(default=None, ge=0, strict=True)

    @model_validator(mode="after")
    def validate_stream_metadata(self) -> Self:
        metadata = (
            self.stream_id,
            self.from_chunk_index,
            self.through_chunk_index,
        )
        if any(value is None for value in metadata) and any(
            value is not None for value in metadata
        ):
            raise ValueError("stream metadata must all be provided or all be omitted")
        if (
            self.from_chunk_index is not None
            and self.through_chunk_index is not None
            and self.from_chunk_index > self.through_chunk_index
        ):
            raise ValueError("from_chunk_index must not exceed through_chunk_index")
        return self


class AssistantReasoningDeltaPayload(ContractModel):
    type: Literal[RuntimeEventType.ASSISTANT_REASONING_DELTA] = (
        RuntimeEventType.ASSISTANT_REASONING_DELTA
    )
    delta: str = Field(min_length=1)


class ToolStartedPayload(ContractModel):
    type: Literal[RuntimeEventType.TOOL_STARTED] = RuntimeEventType.TOOL_STARTED
    tool_call_id: str = Field(min_length=1)
    tool_name: str = Field(min_length=1)
    arguments: dict[str, JsonValue] | None = Field(default=None)


class ConversationCompactedPayload(ContractModel):
    type: Literal[RuntimeEventType.CONVERSATION_COMPACTED] = (
        RuntimeEventType.CONVERSATION_COMPACTED
    )
    covered_through_run_id: str = Field(min_length=1)
    summary_digest: str = Field(pattern=r"^[0-9a-f]{64}$")


class OperationStartedPayload(ContractModel):
    """One skeleton operation started (V2 build execution; Design §15.1)."""

    type: Literal[RuntimeEventType.OPERATION_STARTED] = (
        RuntimeEventType.OPERATION_STARTED
    )
    operation_id: str = Field(min_length=1)
    label: str = ""
    category: str = ""
    attempt: int = Field(ge=1)


class OperationProgressPayload(ContractModel):
    """Mid-operation progress (rows parsed, candidates found, ...)."""

    type: Literal[RuntimeEventType.OPERATION_PROGRESS] = (
        RuntimeEventType.OPERATION_PROGRESS
    )
    operation_id: str = Field(min_length=1)
    kind: str = Field(min_length=1)
    current: int = Field(ge=0)
    total: int | None = Field(default=None, ge=0)
    detail: dict[str, JsonValue] = Field(default_factory=dict)


class OperationCompletedPayload(ContractModel):
    type: Literal[RuntimeEventType.OPERATION_COMPLETED] = (
        RuntimeEventType.OPERATION_COMPLETED
    )
    operation_id: str = Field(min_length=1)
    status: Literal[AttemptStatus.SUCCEEDED, AttemptStatus.SKIPPED] = (
        AttemptStatus.SUCCEEDED
    )
    output_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    reused_operation_attempt_id: str | None = None


class OperationFailedPayload(ContractModel):
    type: Literal[RuntimeEventType.OPERATION_FAILED] = (
        RuntimeEventType.OPERATION_FAILED
    )
    operation_id: str = Field(min_length=1)
    status: Literal[AttemptStatus.FAILED, AttemptStatus.CANCELLED]
    error: ErrorDetail | None = None


class SubagentQueuedPayload(ContractModel):
    type: Literal[RuntimeEventType.SUBAGENT_QUEUED] = RuntimeEventType.SUBAGENT_QUEUED
    subagent_id: str = Field(min_length=1)
    request: SubagentRequest


class SubagentStartedPayload(ContractModel):
    type: Literal[RuntimeEventType.SUBAGENT_STARTED] = RuntimeEventType.SUBAGENT_STARTED
    subagent_id: str = Field(min_length=1)


class SubagentProgressPayload(ContractModel):
    type: Literal[RuntimeEventType.SUBAGENT_PROGRESS] = RuntimeEventType.SUBAGENT_PROGRESS
    subagent_id: str = Field(min_length=1)
    current: int = Field(ge=0)
    total: int | None = Field(default=None, ge=0)
    message: str | None = Field(default=None, min_length=1)


class _SubagentTerminalPayload(ContractModel):
    subagent_id: str = Field(min_length=1)
    result: SubagentResult
    expected_result_status: ClassVar[SubagentStatus]

    @model_validator(mode="after")
    def validate_terminal_result(self) -> Self:
        if self.subagent_id != self.result.subagent_id:
            raise ValueError("payload subagent_id must match result subagent_id")
        if self.result.status is not self.expected_result_status:
            raise ValueError("result status must match terminal event type")
        return self


class SubagentCompletedPayload(_SubagentTerminalPayload):
    type: Literal[RuntimeEventType.SUBAGENT_COMPLETED] = (
        RuntimeEventType.SUBAGENT_COMPLETED
    )
    expected_result_status: ClassVar[SubagentStatus] = SubagentStatus.COMPLETED


class SubagentFailedPayload(_SubagentTerminalPayload):
    type: Literal[RuntimeEventType.SUBAGENT_FAILED] = RuntimeEventType.SUBAGENT_FAILED
    expected_result_status: ClassVar[SubagentStatus] = SubagentStatus.FAILED


class SubagentCancelRequestedPayload(ContractModel):
    type: Literal[RuntimeEventType.SUBAGENT_CANCEL_REQUESTED] = (
        RuntimeEventType.SUBAGENT_CANCEL_REQUESTED
    )
    subagent_id: str = Field(min_length=1)
    reason: str | None = Field(default=None, min_length=1)


class SubagentCancelledPayload(_SubagentTerminalPayload):
    type: Literal[RuntimeEventType.SUBAGENT_CANCELLED] = (
        RuntimeEventType.SUBAGENT_CANCELLED
    )
    expected_result_status: ClassVar[SubagentStatus] = SubagentStatus.CANCELLED


class SubagentInterruptedPayload(_SubagentTerminalPayload):
    type: Literal[RuntimeEventType.SUBAGENT_INTERRUPTED] = (
        RuntimeEventType.SUBAGENT_INTERRUPTED
    )
    expected_result_status: ClassVar[SubagentStatus] = SubagentStatus.INTERRUPTED


class SubagentInputRequiredPayload(ContractModel):
    type: Literal[RuntimeEventType.SUBAGENT_INPUT_REQUIRED] = (
        RuntimeEventType.SUBAGENT_INPUT_REQUIRED
    )
    subagent_id: str = Field(min_length=1)
    request_id: str = Field(min_length=1)
    summary: str = Field(min_length=1)
    prompt_kind: Literal[
        "authentication",
        "captcha",
        "api_key_or_credential",
        "payment",
        "terms_approval",
        "confirmation",
    ]
    expires_at: datetime | None = None
    detail: dict[str, JsonValue] = Field(default_factory=dict)


class SubagentInputResumedPayload(ContractModel):
    type: Literal[RuntimeEventType.SUBAGENT_INPUT_RESUMED] = (
        RuntimeEventType.SUBAGENT_INPUT_RESUMED
    )
    subagent_id: str = Field(min_length=1)
    request_id: str = Field(min_length=1)
    decision: Literal["approve", "reject"]
    detail: dict[str, JsonValue] = Field(default_factory=dict)


EventPayload = Annotated[
    TaskCreatedPayload
    | PlanReadyPayload
    | StageStartedPayload
    | StageCompletedPayload
    | StageFailedPayload
    | StageSkippedPayload
    | StageProgressPayload
    | ToolCalledPayload
    | ToolCompletedPayload
    | WarningPayload
    | ArtifactProducedPayload
    | CancelRequestedPayload
    | TaskCancelledPayload
    | TaskRecoveredPayload
    | TaskCompletedPayload
    | TaskFailedPayload
    | RunQueuedPayload
    | RunStartedPayload
    | RunFinalizingPayload
    | RunCompletedPayload
    | RunFailedPayload
    | RunCancelRequestedPayload
    | RunCancelledPayload
    | RunInterruptedPayload
    | PublicationCreatedPayload
    | UserInputRequiredPayload
    | UserInputResumedPayload
    | AssistantDeltaPayload
    | AssistantReasoningDeltaPayload
    | ToolStartedPayload
    | ConversationCompactedPayload
    | OperationStartedPayload
    | OperationProgressPayload
    | OperationCompletedPayload
    | OperationFailedPayload
    | SubagentQueuedPayload
    | SubagentStartedPayload
    | SubagentProgressPayload
    | SubagentCompletedPayload
    | SubagentFailedPayload
    | SubagentCancelRequestedPayload
    | SubagentCancelledPayload
    | SubagentInterruptedPayload
    | SubagentInputRequiredPayload
    | SubagentInputResumedPayload,
    Field(discriminator="type"),
]


_STAGE_EVENTS = {
    PipelineEventType.STAGE_STARTED,
    PipelineEventType.STAGE_COMPLETED,
    PipelineEventType.STAGE_FAILED,
    PipelineEventType.STAGE_SKIPPED,
}

_SUBAGENT_EVENTS = {
    RuntimeEventType.SUBAGENT_QUEUED,
    RuntimeEventType.SUBAGENT_STARTED,
    RuntimeEventType.SUBAGENT_PROGRESS,
    RuntimeEventType.SUBAGENT_COMPLETED,
    RuntimeEventType.SUBAGENT_FAILED,
    RuntimeEventType.SUBAGENT_CANCEL_REQUESTED,
    RuntimeEventType.SUBAGENT_CANCELLED,
    RuntimeEventType.SUBAGENT_INTERRUPTED,
    RuntimeEventType.SUBAGENT_INPUT_REQUIRED,
    RuntimeEventType.SUBAGENT_INPUT_RESUMED,
}


class EventEnvelope(ContractModel):
    schema_version: Literal["1.0", "2.0"] = "1.0"
    event_id: str = Field(min_length=1)
    type: PipelineEventType | RuntimeEventType
    task_id: str = Field(min_length=1)
    run_id: str | None = Field(default=None, min_length=1)
    stage_attempt_id: str | None = None
    subagent_id: str | None = Field(default=None, min_length=1)
    parent_tool_call_id: str | None = Field(default=None, min_length=1)
    sequence: int = Field(ge=1)
    timestamp: datetime
    payload: EventPayload

    @model_validator(mode="after")
    def validate_envelope(self) -> EventEnvelope:
        if self.type != self.payload.type:
            raise ValueError("event type must match payload type")
        if self.type in _STAGE_EVENTS and not self.stage_attempt_id:
            raise ValueError("stage events require stage_attempt_id")
        has_subagent_linkage = (
            self.subagent_id is not None or self.parent_tool_call_id is not None
        )
        if has_subagent_linkage and self.schema_version != "2.0":
            raise ValueError("subagent linkage requires schema_version 2.0")
        if has_subagent_linkage and not self.run_id:
            raise ValueError("subagent linkage requires run_id")
        if self.type in _SUBAGENT_EVENTS:
            if not self.subagent_id or not self.parent_tool_call_id:
                raise ValueError("subagent events require both envelope linkage fields")
            if self.payload.subagent_id != self.subagent_id:
                raise ValueError(
                    "payload.subagent_id must match envelope.subagent_id"
                )
        runtime_scoped = (
            isinstance(self.type, RuntimeEventType)
            or (
                isinstance(self.payload, ToolCompletedPayload)
                and self.payload.tool_call_id is not None
            )
            or (
                isinstance(self.payload, WarningPayload)
                and self.payload.warning is None
            )
        )
        if (
            self.run_id is not None or runtime_scoped
        ) and self.schema_version != "2.0":
            raise ValueError("run linkage and runtime events require schema_version 2.0")
        if runtime_scoped and not self.run_id:
            raise ValueError("run-scoped events require run_id")
        return self


def build_event(
    *,
    task_id: str,
    sequence: int,
    payload: EventPayload,
    run_id: str | None = None,
    stage_attempt_id: str | None = None,
    subagent_id: str | None = None,
    parent_tool_call_id: str | None = None,
    timestamp: datetime | None = None,
    schema_version: Literal["1.0", "2.0"] | None = None,
) -> EventEnvelope:
    """Build a validated event; persistence assigns task-local sequence."""

    return EventEnvelope(
        schema_version=schema_version
        or ("2.0" if run_id or subagent_id or parent_tool_call_id else "1.0"),
        event_id=generate_prefixed_uuid("event"),
        type=payload.type,
        task_id=task_id,
        run_id=run_id,
        stage_attempt_id=stage_attempt_id,
        subagent_id=subagent_id,
        parent_tool_call_id=parent_tool_call_id,
        sequence=sequence,
        timestamp=timestamp or datetime.now(UTC),
        payload=payload,
    )
