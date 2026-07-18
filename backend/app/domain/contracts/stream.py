"""Ephemeral server frames for the assistant text stream."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


class AssistantStreamDeltaFrame(BaseModel):
    """One non-durable assistant text chunk."""

    model_config = ConfigDict(extra="forbid", strict=True)

    type: Literal["assistant_stream_delta"] = "assistant_stream_delta"
    task_id: str = Field(min_length=1)
    run_id: str = Field(min_length=1)
    stream_id: str = Field(min_length=1)
    chunk_index: int = Field(ge=0)
    delta: str = Field(min_length=1)


class AssistantStreamEndFrame(BaseModel):
    """Marks an ephemeral assistant text stream as finished."""

    model_config = ConfigDict(extra="forbid", strict=True)

    type: Literal["assistant_stream_end"] = "assistant_stream_end"
    task_id: str = Field(min_length=1)
    run_id: str = Field(min_length=1)
    stream_id: str = Field(min_length=1)
    last_chunk_index: int | None = Field(default=None, ge=0)
    finish_reason: str = Field(min_length=1)


AssistantStreamFrame = Annotated[
    AssistantStreamDeltaFrame | AssistantStreamEndFrame,
    Field(discriminator="type"),
]
