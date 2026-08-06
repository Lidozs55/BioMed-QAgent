"""V2 build execution operations (Design §12.2; ARCHITECTURE §5).

An Operation is one step of the server-side fixed build skeleton. Operations
are recorded via append-only ``OperationAttempt`` history with digest matching
for idempotent reuse; they are internal execution records, never an Agent-
declared workflow node (no BuildRecipe, no public BuildStep).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum

from pydantic import Field, JsonValue, field_validator, model_validator

from app.domain.contracts.base import ContractModel
from app.domain.contracts.enums import AttemptStatus
from app.domain.contracts.pipeline import ErrorDetail
from app.pipeline.state import StageOutputFile

_SHA256_PATTERN = r"^[0-9a-f]{64}$"


class OperationKind(StrEnum):
    ACQUIRE = "acquire"
    PARSE = "parse"
    CANONICALIZE = "canonicalize"
    COMPATIBILITY_GATE = "compatibility_gate"
    INTEGRATE = "integrate"
    VALIDATE_PROFILE = "validate_profile"
    PUBLISH = "publish"


@dataclass(frozen=True, slots=True)
class OperationSpec:
    """One node of the fixed build skeleton (produced by the executor's plan)."""

    operation_id: str
    kind: OperationKind
    label: str
    category: str = ""
    upstream: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class OperationOutput:
    """Typed output of one operation, checkpointed by the executor."""

    output: JsonValue
    files: tuple[StageOutputFile, ...] = ()


class OperationAttempt(ContractModel):
    """Append-only execution record for one operation.

    State machine: RUNNING -> SUCCEEDED | FAILED | SKIPPED | CANCELLED.
    A SKIPPED attempt must reference a digest-matched SUCCEEDED predecessor.
    """

    operation_attempt_id: str = Field(min_length=1)
    task_id: str = Field(min_length=1)
    build_id: str = Field(min_length=1)
    operation_id: str = Field(min_length=1)
    attempt: int = Field(ge=1)
    input_digest: str = Field(pattern=_SHA256_PATTERN)
    parameter_digest: str = Field(pattern=_SHA256_PATTERN)
    output_digest: str | None = Field(default=None, pattern=_SHA256_PATTERN)
    status: AttemptStatus
    started_at: datetime | None = None
    finished_at: datetime | None = None
    error: ErrorDetail | None = None
    reused_operation_attempt_id: str | None = None

    @field_validator("input_digest", "parameter_digest")
    @classmethod
    def validate_digest(cls, value: str) -> str:
        return value.lower()

    @model_validator(mode="after")
    def validate_state(self) -> OperationAttempt:
        if self.finished_at is not None and self.started_at is None:
            raise ValueError("finished_at requires started_at")
        if (
            self.started_at is not None
            and self.finished_at is not None
            and self.finished_at < self.started_at
        ):
            raise ValueError("finished_at must not precede started_at")
        if self.status is AttemptStatus.SUCCEEDED:
            if self.output_digest is None:
                raise ValueError("succeeded attempt requires output_digest")
            if self.error is not None:
                raise ValueError("succeeded attempt must not contain error")
        if self.status is AttemptStatus.FAILED and self.error is None:
            raise ValueError("failed attempt requires error")
        if self.status is AttemptStatus.SKIPPED:
            if self.output_digest is None:
                raise ValueError("skipped attempt requires output_digest")
            if self.reused_operation_attempt_id is None:
                raise ValueError("skipped attempt requires reused_operation_attempt_id")
        return self
