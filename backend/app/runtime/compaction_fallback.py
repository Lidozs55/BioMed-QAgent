"""Token-bounded degraded-history fallback for compaction failures."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

from agents.items import TResponseInputItem
from agents.memory import Session

from app.domain.contracts import WarningPayload
from app.model_config.context_budget import ContextBudgetOverflowError

from .compaction_history import EffectiveSession
from .compaction_planning import estimate
from .compaction_types import CompactionPreparation, CompactionRequest

type EventEmitter = Callable[[object], Awaitable[object]]


async def fallback(
    session: Session,
    groups: list[tuple[TResponseInputItem, ...]],
    request: CompactionRequest,
    emit: EventEmitter,
    error: Exception,
    cancellation_requested: asyncio.Event | None,
) -> CompactionPreparation:
    """Warn and retain only the newest complete groups that fit every bound."""

    _raise_if_cancelled(cancellation_requested)
    await emit(
        WarningPayload(
            message=f"conversation compaction failed: {error}",
            code="compaction_failed",
        )
    )
    _raise_if_cancelled(cancellation_requested)
    limit = min(request.budget.target_tokens, request.budget.input_capacity)
    retained = _newest_groups_within_limit(groups, request, limit)
    effective = [item for group in retained for item in group]
    current_estimate = estimate(request, effective)
    if current_estimate.total > limit:
        raise ContextBudgetOverflowError(
            estimated_tokens=current_estimate.total,
            limit_tokens=limit,
        )
    return CompactionPreparation(
        session=EffectiveSession(session, effective),
        agent_input=request.agent_input,
        estimate=current_estimate,
        fallback=True,
    )


def _newest_groups_within_limit(
    groups: list[tuple[TResponseInputItem, ...]],
    request: CompactionRequest,
    limit: int,
) -> list[tuple[TResponseInputItem, ...]]:
    """Return one newest-first-selected, chronological suffix of complete groups."""

    retained: list[tuple[TResponseInputItem, ...]] = []
    for group in reversed(groups):
        candidate = [group, *retained]
        candidate_items = [item for run in candidate for item in run]
        if estimate(request, candidate_items).total > limit:
            break
        retained = candidate
    return retained


def _raise_if_cancelled(cancellation_requested: asyncio.Event | None) -> None:
    """Avoid importing the execution orchestrator to check cancellation."""

    from .compaction_types import CompactionCancelledError

    if cancellation_requested is not None and cancellation_requested.is_set():
        raise CompactionCancelledError("conversation compaction was cancelled")
