"""Typed event payloads and envelope for persistence and replay."""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, Literal

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
    output_digest: str = Field(pattern=r"^[0-9a-f]{64}$")


class WarningPayload(ContractModel):
    type: Literal[PipelineEventType.WARNING] = PipelineEventType.WARNING
    warning: WarningRecord


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
    | TaskFailedPayload,
    Field(discriminator="type"),
]


_STAGE_EVENTS = {
    PipelineEventType.STAGE_STARTED,
    PipelineEventType.STAGE_COMPLETED,
    PipelineEventType.STAGE_FAILED,
    PipelineEventType.STAGE_SKIPPED,
}


class EventEnvelope(ContractModel):
    schema_version: str = Field(default="1.0", min_length=1)
    event_id: str = Field(min_length=1)
    type: PipelineEventType
    task_id: str = Field(min_length=1)
    stage_attempt_id: str | None = None
    sequence: int = Field(ge=1)
    timestamp: datetime
    payload: EventPayload

    @model_validator(mode="after")
    def validate_envelope(self) -> EventEnvelope:
        if self.type is not self.payload.type:
            raise ValueError("event type must match payload type")
        if self.type in _STAGE_EVENTS and not self.stage_attempt_id:
            raise ValueError("stage events require stage_attempt_id")
        return self


def build_event(
    *,
    task_id: str,
    sequence: int,
    payload: EventPayload,
    stage_attempt_id: str | None = None,
    timestamp: datetime | None = None,
) -> EventEnvelope:
    """Build a validated event; persistence assigns task-local sequence."""

    return EventEnvelope(
        event_id=generate_prefixed_uuid("event"),
        type=payload.type,
        task_id=task_id,
        stage_attempt_id=stage_attempt_id,
        sequence=sequence,
        timestamp=timestamp or datetime.now(UTC),
        payload=payload,
    )
