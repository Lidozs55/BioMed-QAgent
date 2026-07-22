"""Public compaction API with stable durable-runtime imports."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from agents import Runner
from agents.items import TResponseInputItem
from agents.memory import Session

from app.domain.contracts import ConversationCompactedPayload
from app.model_config.context_budget import ContextBudgetOverflowError

from . import compaction_summary as _summary
from .compaction_execution import prepare_compaction
from .compaction_types import (
    CompactionCancelledError,
    CompactionPreparation,
    CompactionRequest,
    ConversationSummarizerTruncatedError,
)

type Summarize = Callable[..., Awaitable[str]]
type EventEmitter = Callable[[object], Awaitable[object]]
type CompactionCommit = Callable[[Mapping[str, Any], ConversationCompactedPayload], Awaitable[bool]]

_extract_finish_reason = _summary.extract_finish_reason


async def _summarize_with_model(
    *,
    model_handle: object,
    history: list[TResponseInputItem],
    previous_summary: str | None,
    max_tokens: int | None = None,
) -> str:
    """Run one bounded summarizer request through the patchable SDK runner."""

    _summary.Runner = Runner
    return await _summary.summarize_with_model(
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
