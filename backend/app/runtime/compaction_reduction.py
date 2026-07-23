"""Pure token-budget reduction helpers for conversation compaction."""

from __future__ import annotations

from agents.items import TResponseInputItem

from .compaction_history import ConversationRun, ConversationSegment
from .compaction_planning import HistoryView, estimate
from .compaction_types import CompactionRequest


def select_coverage_prefix(
    request: CompactionRequest,
    view: HistoryView,
    retained: list[ConversationSegment],
) -> list[ConversationRun]:
    """Select only oldest complete Runs that must join a new summary."""

    if view.summary is not None:
        return []
    to_cover: list[ConversationRun] = []
    candidate = list(retained)
    while (
        candidate
        and estimate(request, items_for_segments(candidate)).total
        > request.budget.target_tokens
    ):
        segment = candidate.pop(0)
        if segment.run_ids:
            to_cover.append(ConversationRun(segment.run_ids[0], segment.items))
    return to_cover


def summary_marker(summary: str, covered_through: str) -> TResponseInputItem:
    """Build the prompt item that represents one durable summary marker."""

    return {
        "role": "system",
        "content": f"Conversation summary through {covered_through}:\n{summary}",
    }


def items_for_segments(segments: list[ConversationSegment]) -> list[TResponseInputItem]:
    """Return chronological items from complete retained segments."""

    return [item for segment in segments for item in segment.items]


def shorten_summary(
    summary: str,
    request: CompactionRequest,
    covered_through: str,
) -> str:
    """Deterministically bound a returned summary without another model call."""

    if (
        estimate(request, [summary_marker(summary, covered_through)]).total
        <= request.budget.target_tokens
    ):
        return summary
    low = 0
    high = len(summary)
    while low < high:
        midpoint = (low + high + 1) // 2
        candidate = summary[:midpoint].rstrip()
        if (
            estimate(request, [summary_marker(candidate, covered_through)]).total
            <= request.budget.target_tokens
        ):
            low = midpoint
        else:
            high = midpoint - 1
    return summary[:low].rstrip()
