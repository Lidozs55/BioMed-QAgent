"""Public compaction API with stable durable-runtime imports.

Consolidated from the former ``compaction.py`` + ``compaction_types.py``
(REVIEW 2026-08-05 §5.4 compaction 8→3 merge). The shared request/preparation
types live in ``compaction_planning`` (the dependency leaf) to keep this
module free of import cycles.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from agents import Runner
from agents.items import TResponseInputItem
from agents.memory import Session

from app.domain.contracts import ConversationCompactedPayload
from app.model_config.context_budget import ContextBudgetOverflowError

from . import compaction_execution as _execution
from .compaction_execution import prepare_compaction, summarize_with_model
from .compaction_planning import (
    CompactionCancelledError,
    CompactionPreparation,
    CompactionRequest,
    ConversationSummarizerTruncatedError,
)

type Summarize = Callable[..., Awaitable[str]]
type EventEmitter = Callable[[object], Awaitable[object]]
type CompactionCommit = Callable[[Mapping[str, Any], ConversationCompactedPayload], Awaitable[bool]]


async def _summarize_with_model(
    *,
    model_handle: object,
    history: list[TResponseInputItem],
    previous_summary: str | None,
    max_tokens: int | None = None,
) -> str:
    """Run one bounded summarizer request through the patchable SDK runner."""

    # Keep the patchable Runner reference visible to the execution module so
    # tests that stub ``compaction_module.Runner`` keep working after the
    # 8→3 file consolidation.
    _execution.Runner = Runner
    return await summarize_with_model(
        model_handle=model_handle,
        history=history,
        previous_summary=previous_summary,
        max_tokens=max_tokens,
    )


class ConversationCompactor:
    """Prepare a token-bounded effective session without rewriting raw history."""

    def __init__(self, repository: Any, *, summarize: Summarize = _summarize_with_model) -> None:
        self._repository = repository
        self._summarize = summarize

    async def prepare(
        self,
        task_id: str,
        *,
        model_handle: object,
        emit: EventEmitter,
        request: CompactionRequest | None = None,
        session: Session | None = None,
        cancellation_requested: asyncio.Event | None = None,
        commit: CompactionCommit | None = None,
    ) -> CompactionPreparation:
        """Return an unchanged view when Task 4 has not supplied a budget request."""

        if request is None:
            task_session = session or self._repository.task_session(task_id)
            return CompactionPreparation(session=task_session)
        return await prepare_compaction(
            self._repository,
            self._summarize,
            task_id,
            model_handle,
            emit,
            request,
            session,
            cancellation_requested,
            commit,
        )


__all__ = [
    "CompactionCancelledError",
    "CompactionPreparation",
    "CompactionRequest",
    "ContextBudgetOverflowError",
    "ConversationCompactor",
    "ConversationSummarizerTruncatedError",
]
