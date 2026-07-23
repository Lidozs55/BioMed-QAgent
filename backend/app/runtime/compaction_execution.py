"""Execution of one token-targeted conversation compaction preparation."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from agents.items import TResponseInputItem
from agents.memory import Session

from app.domain.contracts import ConversationCompactedPayload, WarningPayload
from app.model_config.context_budget import ContextBudgetOverflowError

from .compaction_fallback import fallback
from .compaction_history import EffectiveSession
from .compaction_planning import (
    HistoryView,
    build_history_view,
    effective_items,
    estimate,
    summary_record,
)
from .compaction_reduction import (
    items_for_segments,
    select_coverage_prefix,
    shorten_summary,
    summary_marker,
)
from .compaction_types import (
    CompactionCancelledError,
    CompactionPreparation,
    CompactionRequest,
    ConversationSummarizerTruncatedError,
    HistoryAlignmentError,
)

type Summarize = Callable[..., Awaitable[str]]
type EventEmitter = Callable[[object], Awaitable[object]]
type CompactionCommit = Callable[[Mapping[str, Any], ConversationCompactedPayload], Awaitable[bool]]


async def prepare_compaction(
    repository: Any,
    summarize: Summarize,
    task_id: str,
    model_handle: object,
    emit: EventEmitter,
    request: CompactionRequest,
    session: Session | None,
    cancellation_requested: asyncio.Event | None,
    commit: CompactionCommit | None,
) -> CompactionPreparation:
    """Return a token-bounded effective session without mutating raw history."""

    raise_if_cancelled(cancellation_requested)
    fixed_estimate = estimate(request, [])
    if fixed_estimate.total > request.budget.input_capacity:
        raise ContextBudgetOverflowError(
            estimated_tokens=fixed_estimate.total,
            limit_tokens=request.budget.input_capacity,
        )
    task_session = session or repository.task_session(task_id)
    items = await task_session.get_items()
    raw_estimate = estimate(request, items)
    if raw_estimate.total < request.budget.trigger_tokens:
        return CompactionPreparation(
            session=task_session,
            agent_input=request.agent_input,
            estimate=raw_estimate,
        )
    groups = split_groups(items)
    try:
        snapshot = await repository.get_snapshot(task_id)
        if snapshot is None:
            raise ValueError(f"task snapshot not found: {task_id}")
        marker = await repository.load_conversation_summary(task_id)
        view = build_history_view(marker, snapshot, groups)
    except (HistoryAlignmentError, ValueError) as error:
        return await fallback(
            task_session,
            groups,
            request,
            emit,
            error,
            cancellation_requested,
        )
    effective = effective_items(view, list(view.segments))
    effective_estimate = estimate(request, effective)
    if effective_estimate.total < request.budget.trigger_tokens:
        return CompactionPreparation(
            session=(
                task_session
                if view.summary is None
                else EffectiveSession(task_session, effective)
            ),
            agent_input=request.agent_input,
            estimate=effective_estimate,
        )
    try:
        return await compact_view(
            repository,
            summarize,
            task_id,
            task_session,
            model_handle,
            emit,
            request,
            view,
            cancellation_requested,
            commit,
        )
    except (CompactionCancelledError, ConversationSummarizerTruncatedError):
        raise
    except ValueError as error:
        return await fallback(
            task_session,
            groups,
            request,
            emit,
            error,
            cancellation_requested,
        )


async def compact_view(
    repository: Any,
    summarize: Summarize,
    task_id: str,
    task_session: Session,
    model_handle: object,
    emit: EventEmitter,
    request: CompactionRequest,
    view: HistoryView,
    cancellation_requested: asyncio.Event | None,
    commit: CompactionCommit | None,
) -> CompactionPreparation:
    """Use at most one bounded summary call before evicting retained segments."""

    retained = list(view.segments)
    covered = list(view.covered_runs)
    to_cover = select_coverage_prefix(request, view, retained)
    del retained[: len(to_cover)]
    covered.extend(to_cover)
    covered_through = covered[-1].run_id if covered else "history_start"
    summary_limit = max(
        1,
        request.budget.target_tokens
        - estimate(request, [summary_marker("", covered_through)]).total,
    )
    raise_if_cancelled(cancellation_requested)
    summary = await summarize(
        model_handle=model_handle,
        history=[item for run in to_cover for item in run.items],
        previous_summary=view.summary,
        max_tokens=summary_limit,
    )
    raise_if_cancelled(cancellation_requested)
    if not isinstance(summary, str) or not summary.strip():
        raise ValueError("conversation summarizer returned no text")
    summary = shorten_summary(summary.strip(), request, covered_through)
    effective = [summary_marker(summary, covered_through), *items_for_segments(retained)]
    current_estimate = estimate(request, effective)
    while current_estimate.total > request.budget.target_tokens and retained:
        retained.pop(0)
        effective = [summary_marker(summary, covered_through), *items_for_segments(retained)]
        current_estimate = estimate(request, effective)
    if current_estimate.total > request.budget.target_tokens:
        raise ContextBudgetOverflowError(
            estimated_tokens=current_estimate.total,
            limit_tokens=request.budget.target_tokens,
        )
    record = summary_record(summary, covered)
    payload = ConversationCompactedPayload(
        covered_through_run_id=covered_through,
        summary_digest=record["summary_digest"],
    )
    if commit is None:
        await repository.save_conversation_summary(task_id, record)
        await emit(payload)
    elif not await commit(record, payload):
        raise CompactionCancelledError("conversation compaction commit was cancelled")
    if view.degraded_alignment:
        await emit(
            WarningPayload(
                code="compaction_alignment_degraded",
                message=(
                    "conversation compaction retained a valid summary with "
                    "ambiguous suffix alignment"
                ),
            )
        )
    return CompactionPreparation(
        session=EffectiveSession(task_session, effective),
        agent_input=request.agent_input,
        estimate=current_estimate,
        compacted=True,
        degraded_alignment=view.degraded_alignment,
    )


def raise_if_cancelled(cancellation_requested: asyncio.Event | None) -> None:
    """Abort before emitting or committing after a cancellation request."""

    if cancellation_requested is not None and cancellation_requested.is_set():
        raise CompactionCancelledError("conversation compaction was cancelled")


def split_groups(items: list[TResponseInputItem]) -> list[tuple[TResponseInputItem, ...]]:
    """Import locally to keep the execution module focused on orchestration."""

    from .compaction_history import split_session_runs

    return split_session_runs(items)
