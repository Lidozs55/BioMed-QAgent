"""Contracts for durable multi-turn tasks, runs, and messages."""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Self

from pydantic import Field, JsonValue, field_validator, model_validator

from app.domain.contracts.base import ContractModel
from app.domain.contracts.enums import (
    MessageRole,
    RunStatus,
    SubagentErrorCode,
    SubagentStatus,
    SubagentType,
    TaskMode,
)


class RunRecord(ContractModel):
    run_id: str = Field(min_length=1)
    task_id: str = Field(min_length=1)
    request_id: str = Field(min_length=1)
    status: RunStatus
    input: str = Field(min_length=1)
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    error: str | None = Field(default=None, min_length=1)

    @model_validator(mode="after")
    def validate_timestamps(self) -> Self:
        if self.updated_at < self.created_at:
            raise ValueError("updated_at must not precede created_at")
        if self.started_at is not None and self.started_at < self.created_at:
            raise ValueError("started_at must not precede created_at")
        if (
            self.finished_at is not None
            and self.started_at is not None
            and self.finished_at < self.started_at
        ):
            raise ValueError("finished_at must not precede started_at")
        return self


class TaskSummary(ContractModel):
    task_id: str = Field(min_length=1)
    mode: TaskMode
    databases: list[str] = Field(default_factory=list)
    title: str = Field(min_length=1)
    status: RunStatus
    active_run_id: str | None = Field(default=None, min_length=1)
    created_at: datetime
    updated_at: datetime
    latest_sequence: int = Field(default=0, ge=0)
    artifact_count: int = Field(default=0, ge=0)


class MessageRecord(ContractModel):
    message_id: str = Field(min_length=1)
    task_id: str = Field(min_length=1)
    run_id: str | None = Field(default=None, min_length=1)
    ordinal: int = Field(ge=1)
    role: MessageRole
    content: str
    created_at: datetime


class SubagentRecord(ContractModel):
    subagent_id: str = Field(min_length=1)
    task_id: str = Field(min_length=1)
    run_id: str = Field(min_length=1)
    agent_type: SubagentType
    objective: str = Field(min_length=1)
    target_source: str | None = Field(default=None, min_length=1)
    status: SubagentStatus
    parent_tool_call_id: str = Field(min_length=1)
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    progress_current: int = Field(ge=0)
    progress_total: int | None = Field(default=None, ge=0)
    progress_message: str | None = Field(default=None, min_length=1)
    result_summary: str | None = Field(default=None, min_length=1)
    source_asset_ids: list[str] = Field(default_factory=list)
    recipe_id: str | None = Field(default=None, min_length=1)
    error_code: SubagentErrorCode | None = None
    error_message: str | None = Field(default=None, min_length=1)
    pending_request_id: str | None = Field(default=None, min_length=1)


class SubagentRequest(ContractModel):
    agent_type: SubagentType
    objective: str = Field(min_length=1)
    target_source: str | None = Field(default=None, min_length=1)
    domain: str = Field(min_length=1)
    capability: str = Field(min_length=1)
    inputs: dict[str, JsonValue] = Field(default_factory=dict)


class SubagentResult(ContractModel):
    subagent_id: str = Field(min_length=1)
    status: SubagentStatus
    summary: str = Field(min_length=1)
    source_asset_ids: list[str] = Field(default_factory=list)
    recipe_id: str | None = Field(default=None, min_length=1)
    warnings: list[str] = Field(default_factory=list)
    error_code: SubagentErrorCode | None = None
    error_message: str | None = Field(default=None, min_length=1)

    @field_validator("status")
    @classmethod
    def validate_terminal_status(cls, value: SubagentStatus) -> SubagentStatus:
        if value not in {
            SubagentStatus.COMPLETED,
            SubagentStatus.FAILED,
            SubagentStatus.CANCELLED,
            SubagentStatus.INTERRUPTED,
        }:
            raise ValueError("status must be terminal")
        return value


class TaskSnapshot(ContractModel):
    task: TaskSummary
    runs: list[RunRecord] = Field(default_factory=list)
    messages: list[MessageRecord] = Field(default_factory=list)
    subagents: list[SubagentRecord] = Field(default_factory=list)
    older_messages_cursor: str | None = None


class TaskPage(ContractModel):
    active_items: list[TaskSummary] = Field(default_factory=list)
    items: list[TaskSummary] = Field(default_factory=list)
    next_cursor: str | None = None

    @property
    def tasks(self) -> list[TaskSummary]:
        """Compatibility view for runtime consumers; not part of the wire model."""

        return sorted(
            [*self.active_items, *self.items],
            key=lambda task: (task.created_at, task.task_id),
            reverse=True,
        )


class MessagePage(ContractModel):
    messages: list[MessageRecord] = Field(default_factory=list)
    next_cursor: str | None = None


class _StartRequest(ContractModel):
    request_id: str = Field(min_length=1)
    input: str

    @field_validator("request_id")
    @classmethod
    def validate_request_id(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("request_id must not be blank")
        return normalized

    @field_validator("input")
    @classmethod
    def validate_input(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("input must not be blank")
        return normalized


def validate_task_databases(mode: TaskMode | str, databases: list[str]) -> None:
    """Enforce mode-specific database selection at every admission boundary.

    Fixture mode no longer restricts databases to pubmed+geo — the pipeline
    will attempt discovery for any selected database and fail gracefully at
    the acquisition stage for unsupported sources.
    """

    normalized_mode = TaskMode(mode)
    _ = normalized_mode
    _ = databases
    # IMPORT 任务不绑定外部数据库：用户文件本身就是数据源，
    # 缓存查询通过 local_cache acquisition skill 完成（D2）。


class StartTaskRequest(_StartRequest):
    databases: list[str] = Field(default_factory=list)
    mode: TaskMode = TaskMode.AGENT

    @model_validator(mode="after")
    def validate_databases(self) -> Self:
        validate_task_databases(self.mode, self.databases)
        return self


class StartRunRequest(_StartRequest):
    pass


class TaskRunAccepted(ContractModel):
    request_id: str = Field(min_length=1)
    task_id: str = Field(min_length=1)
    run_id: str = Field(min_length=1)
    status: Literal[RunStatus.QUEUED] = RunStatus.QUEUED
