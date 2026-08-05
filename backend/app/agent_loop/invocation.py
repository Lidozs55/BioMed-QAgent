"""Per-invocation preflight builder with model-aware CompactionRequest construction.

Each invocation builds a fresh :class:`CompactionRequest` from the current
``agent_input`` and calls the compactor immediately before the SDK call.
This replaces the legacy one-time preparation so every continuation and retry
is gated by token-budget constraints.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import TYPE_CHECKING

from app.model_config.context_budget import ContextBudget
from app.model_config.token_estimation import (
    ChatCompletionsPromptShape,
    PromptTokenEstimate,
    PromptTokenEstimator,
    select_text_token_counter,
)
from app.runtime.compaction import CompactionRequest

if TYPE_CHECKING:
    from agents.items import TResponseInputItem
    from agents.memory import Session

    from app.agent_loop.context import RunContext
    from app.runtime.compaction import (
        CompactionCommit,
        CompactionPreparation,
        ConversationCompactor,
        EventEmitter,
    )


@dataclass(frozen=True, slots=True)
class InvocationPreflight:
    """Builds a fresh :class:`CompactionRequest` from immutable Run resources.

    Every attribute is frozen for the lifetime of one managed Run.
    """

    budget: ContextBudget
    prompt_shape: ChatCompletionsPromptShape
    estimator: PromptTokenEstimator
    base_instructions: str
    compactor: ConversationCompactor

    @classmethod
    def from_budget(
        cls,
        budget: ContextBudget,
        prompt_shape: ChatCompletionsPromptShape,
        compactor: ConversationCompactor,
    ) -> InvocationPreflight:
        """Build one preflight from a resolved budget and Agent build shape."""
        counter = select_text_token_counter(budget.provider_origin, budget.model_name)
        return cls(
            budget=budget,
            prompt_shape=prompt_shape,
            estimator=PromptTokenEstimator(counter=counter),
            base_instructions=prompt_shape.instructions,
            compactor=compactor,
        )

    async def preflight(
        self,
        task_id: str,
        agent_input: str | list[TResponseInputItem],
        *,
        model_handle: object,
        emit: EventEmitter,
        session: Session,
        cancellation_requested: asyncio.Event | None,
        commit: CompactionCommit | None,
        context: RunContext | None = None,
    ) -> CompactionPreparation:
        """Build and run a model-aware compaction request for one invocation.

        Raises:
            ContextBudgetOverflowError: The fixed prompt exceeds capacity.
            CompactionCancelledError: The Run was cancelled during preparation.
        """
        from app.agent_loop.agent import resolve_agent_instructions

        resolved_instructions = (
            resolve_agent_instructions(self.base_instructions, context)
            if context is not None
            else self.base_instructions
        )
        request = CompactionRequest(
            agent_input=agent_input,
            prompt_shape=self.prompt_shape,
            resolved_instructions=resolved_instructions,
            budget=self.budget,
            estimator=self.estimator,
        )
        return await self.compactor.prepare(
            task_id,
            model_handle=model_handle,
            emit=emit,
            request=request,
            session=session,
            cancellation_requested=cancellation_requested,
            commit=commit,
        )


def record_calibration_from_result(
    result: object,
    estimate: PromptTokenEstimate,
    budget: ContextBudget,
) -> None:
    """Record a positive input-token residual after one successful SDK invocation.

    Only authoritative ``input_tokens`` from the public provider response are
    considered.  Missing, unsupported, or zero input usage is a no-op.  The
    active Run budget is never mutated — a later managed Run can capture the
    new margin.
    """
    raw_responses = _safe_getattr(result, "raw_responses")
    if not raw_responses:
        return
    last = raw_responses[-1]
    usage = _safe_getattr(last, "usage")
    if usage is None:
        return
    actual_input = _safe_getattr(usage, "input_tokens", 0)
    if not isinstance(actual_input, int) or actual_input <= 0:
        return
    estimated_total = max(0, estimate.total - budget.calibration_margin_tokens)
    residual = actual_input - estimated_total
    if residual <= 0:
        return
    # Access the current calibration store dynamically so tests can swap it.
    from app.model_settings import _current_store

    _current_store.record_calibration_residual(budget, residual)


def _safe_getattr(obj: object, name: str, default: object = None) -> object:
    """Return ``obj.name`` without triggering exception on missing attributes."""
    return getattr(obj, name, default)
