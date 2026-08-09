"""Execution, degraded-history fallback and model-backed summarization.

Consolidated from the former ``compaction_execution.py`` +
``compaction_fallback.py`` + ``compaction_summary.py``
(REVIEW 2026-08-05 §5.4 compaction 8→3 merge).
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from agents import Agent, ModelSettings, Runner
from agents.items import TResponseInputItem
from agents.memory import Session
from agents.stream_events import RawResponsesStreamEvent

from app.domain.contracts import ConversationCompactedPayload, WarningPayload
from app.model_config.context_budget import ContextBudgetOverflowError

from .compaction_planning import (
    CompactionCancelledError,
    CompactionPreparation,
    CompactionRequest,
    ConversationSummarizerTruncatedError,
    EffectiveSession,
    HistoryAlignmentError,
    HistoryView,
    build_history_view,
    effective_items,
    estimate,
    items_for_segments,
    select_coverage_prefix,
    shorten_summary,
    split_session_runs,
    summary_marker,
    summary_record,
)

type Summarize = Callable[..., Awaitable[str]]
type EventEmitter = Callable[[object], Awaitable[object]]
type CompactionCommit = Callable[[Mapping[str, Any], ConversationCompactedPayload], Awaitable[bool]]


# ---------------------------------------------------------------------------
# Execution orchestration
# ---------------------------------------------------------------------------


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
    if not to_cover and not covered:
        # 无可压缩内容（纯在飞会话 / 摘要已覆盖全部）：不调用 summarize，
        # 原样保留在飞段；超出硬容量时显式失败而不是产出空输入。
        current_estimate = estimate(request, items_for_segments(retained))
        if current_estimate.total > request.budget.input_capacity:
            raise ContextBudgetOverflowError(
                estimated_tokens=current_estimate.total,
                limit_tokens=request.budget.input_capacity,
            )
        return CompactionPreparation(
            session=EffectiveSession(task_session, items_for_segments(retained)),
            agent_input=request.agent_input,
            estimate=current_estimate,
            compacted=False,
            degraded_alignment=view.degraded_alignment,
        )
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
        if not retained[0].run_ids:
            # 在飞段（活动会话）永不弹岀。
            break
        retained.pop(0)
        effective = [summary_marker(summary, covered_through), *items_for_segments(retained)]
        current_estimate = estimate(request, effective)
    if current_estimate.total > request.budget.target_tokens and any(
        segment.run_ids for segment in retained
    ):
        # 仍有可压缩历史段却无法达标：摘要未充分减小，显式失败。
        raise ContextBudgetOverflowError(
            estimated_tokens=current_estimate.total,
            limit_tokens=request.budget.target_tokens,
        )
    if current_estimate.total > request.budget.input_capacity:
        # 仅剩不可压缩的在飞段且超出硬容量。
        raise ContextBudgetOverflowError(
            estimated_tokens=current_estimate.total,
            limit_tokens=request.budget.input_capacity,
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
    """Group raw session items into complete user-started exchanges."""

    return split_session_runs(items)


# ---------------------------------------------------------------------------
# Degraded-history fallback
# ---------------------------------------------------------------------------


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
    if current_estimate.total > limit and len(retained) > 1:
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
    """Return one newest-first-selected, chronological suffix of complete groups.

    Never returns empty when *groups* is non-empty: the newest complete group
    is always retained even when it alone exceeds the limit, so a continuation
    can never reach ``Runner.run_streamed`` with an empty prepared input.
    """

    retained: list[tuple[TResponseInputItem, ...]] = []
    for group in reversed(groups):
        candidate = [group, *retained]
        candidate_items = [item for run in candidate for item in run]
        if estimate(request, candidate_items).total > limit and retained:
            break
        retained = candidate
    return retained


def _raise_if_cancelled(cancellation_requested: asyncio.Event | None) -> None:
    """Abort the fallback after cancellation wins the race."""

    if cancellation_requested is not None and cancellation_requested.is_set():
        raise CompactionCancelledError("conversation compaction was cancelled")


# ---------------------------------------------------------------------------
# Model-backed summary generation
# ---------------------------------------------------------------------------


def extract_finish_reason(data: object) -> str | None:
    """Extract a Chat Completions finish reason from one raw event."""

    choices = getattr(data, "choices", None)
    if not choices:
        return None
    finish_reason = getattr(choices[0], "finish_reason", None)
    if isinstance(finish_reason, str) and finish_reason:
        return finish_reason
    return None


async def summarize_with_model(
    *,
    model_handle: object,
    history: list[TResponseInputItem],
    previous_summary: str | None,
    max_tokens: int | None = None,
) -> str:
    """Request one faithful, non-truncated conversation summary."""

    summarizer = Agent(
        name="ConversationSummarizer",
        instructions=(
            "Summarize the conversation faithfully for continuation. Preserve user "
            "goals, biomedical entities, tool findings, decisions, warnings, and "
            "unresolved work. Do not call tools."
        ),
        tools=[],
        model=model_handle,
        model_settings=ModelSettings(max_tokens=max_tokens),
    )
    payload = {"previous_summary": previous_summary, "history": history}
    result = Runner.run_streamed(
        summarizer,
        json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=str),
        max_turns=1,
    )
    finish_reason: str | None = None
    async for event in result.stream_events():
        if isinstance(event, RawResponsesStreamEvent):
            event_reason = extract_finish_reason(event.data)
            if event_reason:
                finish_reason = event_reason
    if finish_reason == "length":
        raise ConversationSummarizerTruncatedError(
            "conversation summarizer LLM output was truncated "
            "(finish_reason=length); refusing to use a partial summary"
        )
    summary = result.final_output
    if not isinstance(summary, str) or not summary.strip():
        raise ValueError("conversation summarizer returned no text")
    return summary.strip()
