"""Typed event payloads and envelope for persistence and replay."""

from __future__ import annotations

from datetime import datetime, timezone
from enum import StrEnum
from typing import Annotated, Literal, Self

from pydantic import Field, model_validator

from app.domain.contracts.base import ContractModel
from app.domain.contracts.enums import AttemptStatus, StageName
from app.domain.contracts.ids import generate_prefixed_uuid
from app.domain.contracts.pipeline import (
    ArtifactManifestEntry,
    ErrorDetail,
    ValidationSummary,
    WarningRecord,
)
from app.domain.contracts.task import TaskSpecification


class PipelineEventType(StrEnum):
    TASK_CREATED = "task_created"
    PLAN_READY = "plan_ready"
    STAGE_STARTED = "stage_started"
    STAGE_COMPLETED = "stage_completed"
    STAGE_FAILED = "stage_failed"
    STAGE_SKIPPED = "stage_skipped"
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
    ASSISTANT_DELTA = "assistant_delta"
    TOOL_STARTED = "tool_started"
    CONVERSATION_COMPACTED = "conversation_compacted"


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


class ToolCalledPayload(ContractModel):
    type: Literal[PipelineEventType.TOOL_CALLED] = PipelineEventType.TOOL_CALLED
    tool_name: str = Field(min_length=1)
    arguments_digest: str = Field(pattern=r"^[0-9a-f]{64}$")


class ToolCompletedPayload(ContractModel):
    type: Literal[PipelineEventType.TOOL_COMPLETED] = PipelineEventType.TOOL_COMPLETED
    tool_name: str = Field(min_length=1)
    output_digest: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    tool_call_id: str | None = Field(default=None, min_length=1)
    output: str | None = None
    is_error: bool = False

    @model_validator(mode="after")
    def validate_fixture_or_runtime_shape(self) -> Self:
        if self.output_digest is None and self.tool_call_id is None:
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


class TaskFailedPayload(ContractModel):
    type: Literal[PipelineEventType.TASK_FAILED] = PipelineEventType.TASK_FAILED
    error: ErrorDetail


class RunQueuedPayload(ContractModel):
    type: Literal[RuntimeEventType.RUN_QUEUED] = RuntimeEventType.RUN_QUEUED
    request_id: str = Field(min_length=1)
    input: str = Field(min_length=1)


class RunStartedPayload(ContractModel):
    type: Literal[RuntimeEventType.RUN_STARTED] = RuntimeEventType.RUN_STARTED


class RunFinalizingPayload(ContractModel):
    type: Literal[RuntimeEventType.RUN_FINALIZING] = RuntimeEventType.RUN_FINALIZING


class RunCompletedPayload(ContractModel):
    type: Literal[RuntimeEventType.RUN_COMPLETED] = RuntimeEventType.RUN_COMPLETED


class RunFailedPayload(ContractModel):
    type: Literal[RuntimeEventType.RUN_FAILED] = RuntimeEventType.RUN_FAILED
    error: str = Field(min_length=1)


class RunCancelRequestedPayload(ContractModel):
    type: Literal[RuntimeEventType.RUN_CANCEL_REQUESTED] = (
        RuntimeEventType.RUN_CANCEL_REQUESTED
    )
    reason: str | None = Field(default=None, min_length=1)


class RunCancelledPayload(ContractModel):
    type: Literal[RuntimeEventType.RUN_CANCELLED] = RuntimeEventType.RUN_CANCELLED
    reason: str | None = Field(default=None, min_length=1)


class RunInterruptedPayload(ContractModel):
    type: Literal[RuntimeEventType.RUN_INTERRUPTED] = RuntimeEventType.RUN_INTERRUPTED
    reason: str = Field(min_length=1)


class AssistantDeltaPayload(ContractModel):
    type: Literal[RuntimeEventType.ASSISTANT_DELTA] = (
        RuntimeEventType.ASSISTANT_DELTA
    )
    delta: str = Field(min_length=1)


class ToolStartedPayload(ContractModel):
    type: Literal[RuntimeEventType.TOOL_STARTED] = RuntimeEventType.TOOL_STARTED
    tool_call_id: str = Field(min_length=1)
    tool_name: str = Field(min_length=1)


class ConversationCompactedPayload(ContractModel):
    type: Literal[RuntimeEventType.CONVERSATION_COMPACTED] = (
        RuntimeEventType.CONVERSATION_COMPACTED
    )
    covered_through_run_id: str = Field(min_length=1)
    summary_digest: str = Field(pattern=r"^[0-9a-f]{64}$")


EventPayload = Annotated[
    TaskCreatedPayload
    | PlanReadyPayload
    | StageStartedPayload
    | StageCompletedPayload
    | StageFailedPayload
    | StageSkippedPayload
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
    | AssistantDeltaPayload
    | ToolStartedPayload
    | ConversationCompactedPayload,
    Field(discriminator="type"),
]


_STAGE_EVENTS = {
    PipelineEventType.STAGE_STARTED,
    PipelineEventType.STAGE_COMPLETED,
    PipelineEventType.STAGE_FAILED,
    PipelineEventType.STAGE_SKIPPED,
}


class EventEnvelope(ContractModel):
    schema_version: Literal["1.0", "2.0"] = "1.0"
    event_id: str = Field(min_length=1)
    type: PipelineEventType | RuntimeEventType
    task_id: str = Field(min_length=1)
    run_id: str | None = Field(default=None, min_length=1)
    stage_attempt_id: str | None = None
    sequence: int = Field(ge=1)
    timestamp: datetime
    payload: EventPayload

    @model_validator(mode="after")
    def validate_envelope(self) -> "EventEnvelope":
        if self.type != self.payload.type:
            raise ValueError("event type must match payload type")
        if self.type in _STAGE_EVENTS and not self.stage_attempt_id:
            raise ValueError("stage events require stage_attempt_id")
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
    timestamp: datetime | None = None,
    schema_version: Literal["1.0", "2.0"] | None = None,
) -> EventEnvelope:
    """Build a validated event; persistence assigns task-local sequence."""

    return EventEnvelope(
        schema_version=schema_version or ("2.0" if run_id else "1.0"),
        event_id=generate_prefixed_uuid("event"),
        type=payload.type,
        task_id=task_id,
        run_id=run_id,
        stage_attempt_id=stage_attempt_id,
        sequence=sequence,
        timestamp=timestamp or datetime.now(timezone.utc),
        payload=payload,
    )
