"""Typed request and result values for conversation compaction."""

from __future__ import annotations

from dataclasses import dataclass

from agents.items import TResponseInputItem
from agents.memory import Session

from app.model_config.context_budget import ContextBudget
from app.model_config.token_estimation import (
    ChatCompletionsPromptShape,
    PromptTokenEstimate,
    PromptTokenEstimator,
)


class HistoryAlignmentError(ValueError):
    """Raised when raw conversational groups have no unique Run mapping."""


class CompactionCancelledError(RuntimeError):
    """Raised when cancellation wins before a new Agent Run starts."""


class ConversationSummarizerTruncatedError(RuntimeError):
    """Raised when a summarizer emits a partial length-truncated summary."""




@dataclass(frozen=True, slots=True)
class CompactionRequest:
    """Exact prompt inputs and immutable budget for one preparation attempt."""

    agent_input: str | list[TResponseInputItem]
    prompt_shape: ChatCompletionsPromptShape
    resolved_instructions: str
    budget: ContextBudget
    estimator: PromptTokenEstimator


_EMPTY_ESTIMATE = PromptTokenEstimate(
    content_tokens=0,
    message_wrapper_tokens=0,
    instruction_tokens=0,
    tool_schema_tokens=0,
    current_input_tokens=0,
    calibration_margin_tokens=0,
)


@dataclass(frozen=True, slots=True)
class CompactionPreparation:
    """The SDK session/input view selected for the upcoming Agent Run."""

    session: Session
    agent_input: str | list[TResponseInputItem] = ""
    estimate: PromptTokenEstimate = _EMPTY_ESTIMATE
    compacted: bool = False
    degraded_alignment: bool = False
    fallback: bool = False
