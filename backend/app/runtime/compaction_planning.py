"""Durable-session planning and token-budget reduction for conversation compaction.

Consolidated from the former ``compaction_types.py`` +
``compaction_history.py`` + ``compaction_planning.py`` +
``compaction_reduction.py`` (REVIEW 2026-08-05 §5.4 compaction 8→3 merge).
This module is the dependency leaf: it owns the shared request/preparation
types so neither ``compaction`` nor ``compaction_execution`` needs to import
back into a module that imports them.
"""

from __future__ import annotations

import copy
import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from agents.items import TResponseInputItem
from agents.memory import Session

from app.domain.contracts import RunStatus
from app.model_config.context_budget import ContextBudget
from app.model_config.token_estimation import (
    CandidateChatCompletionsPrompt,
    ChatCompletionsPromptShape,
    PromptTokenEstimate,
    PromptTokenEstimator,
)

_TERMINAL_RUN_STATUSES = {
    RunStatus.COMPLETED,
    RunStatus.FAILED,
    RunStatus.CANCELLED,
    RunStatus.INTERRUPTED,
}


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


@dataclass(frozen=True, slots=True)
class ConversationRun:
    """One complete durable Run exchange."""

    run_id: str
    items: tuple[TResponseInputItem, ...]


@dataclass(frozen=True, slots=True)
class ConversationSegment:
    """An indivisible effective-history segment retained or evicted as a unit."""

    run_ids: tuple[str, ...]
    items: tuple[TResponseInputItem, ...]


class EffectiveSession:
    """Override reads for one Run while delegating every durable mutation."""

    def __init__(self, underlying: Session, effective_items: list[TResponseInputItem]) -> None:
        self._underlying = underlying
        self._effective_items = copy.deepcopy(effective_items)
        self.session_settings = getattr(underlying, "session_settings", None)

    async def get_items(self, limit: int | None = None) -> list[TResponseInputItem]:
        if limit is None:
            selected = self._effective_items
        elif limit:
            selected = self._effective_items[-limit:]
        else:
            selected = []
        return copy.deepcopy(selected)

    async def add_items(self, items: list[TResponseInputItem]) -> None:
        await self._underlying.add_items(items)

    async def pop_item(self) -> TResponseInputItem | None:
        return await self._underlying.pop_item()

    async def clear_session(self) -> None:
        await self._underlying.clear_session()


def content_text(value: object) -> str:
    """Return comparable text from one SDK message field."""

    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(
            content_text(part.get("text", part.get("content", "")))
            if isinstance(part, Mapping)
            else content_text(part)
            for part in value
        )
    if value is None:
        return ""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def item_value(item: object, name: str, default: object = None) -> object:
    """Read an SDK item from its mapping or object representation."""

    if isinstance(item, Mapping):
        return item.get(name, default)
    return getattr(item, name, default)


def split_session_runs(items: list[TResponseInputItem]) -> list[tuple[TResponseInputItem, ...]]:
    """Group raw session items into complete user-started exchanges."""

    groups: list[list[TResponseInputItem]] = []
    for item in items:
        if item_value(item, "role") == "user":
            groups.append([])
        if groups:
            groups[-1].append(item)
    return [tuple(group) for group in groups if group]


def terminal_runs(snapshot: Any) -> list[Any]:
    """Return the chronological terminal durable Runs available for alignment."""

    return [run for run in snapshot.runs if run.status in _TERMINAL_RUN_STATUSES]


def align_runs(snapshot: Any, items: list[TResponseInputItem]) -> list[ConversationRun]:
    """Uniquely align complete raw exchanges with terminal durable Runs."""

    groups = split_session_runs(items)
    return align_groups_to_records(groups, terminal_runs(snapshot))


def align_groups_to_records(
    groups: list[tuple[TResponseInputItem, ...]],
    records: list[Any],
) -> list[ConversationRun]:
    """Uniquely align one raw-group suffix with one durable-Run suffix."""

    inputs = [content_text(item_value(group[0], "content", "")).strip() for group in groups]

    @lru_cache(maxsize=4096)
    def mapping_count(group_index: int, record_index: int) -> int:
        if group_index == len(groups):
            return 1
        if record_index == len(records):
            return 0
        count = mapping_count(group_index, record_index + 1)
        if records[record_index].input == inputs[group_index]:
            count += mapping_count(group_index + 1, record_index + 1)
        return min(count, 2)

    count = mapping_count(0, 0)
    if count == 0:
        raise HistoryAlignmentError("conversation history alignment is impossible")
    if count > 1:
        raise HistoryAlignmentError("conversation history alignment is ambiguous")

    aligned: list[ConversationRun] = []
    record_index = 0
    for group_index, group in enumerate(groups):
        while record_index < len(records):
            matches = records[record_index].input == inputs[group_index]
            suffix_count = mapping_count(group_index + 1, record_index + 1) if matches else 0
            if suffix_count:
                aligned.append(ConversationRun(records[record_index].run_id, group))
                record_index += 1
                break
            record_index += 1
    return aligned


def flatten(runs: list[ConversationRun]) -> list[TResponseInputItem]:
    """Copy all items in chronological Run order."""

    return [copy.deepcopy(item) for run in runs for item in run.items]


def flatten_segments(segments: list[ConversationSegment]) -> list[TResponseInputItem]:
    """Copy all retained segments in chronological order."""

    return [copy.deepcopy(item) for segment in segments for item in segment.items]


def flatten_groups(groups: list[tuple[TResponseInputItem, ...]]) -> list[TResponseInputItem]:
    """Copy raw groups without asserting their durable ownership."""

    return [copy.deepcopy(item) for group in groups for item in group]


def digest_items(items: list[TResponseInputItem]) -> str:
    """Return a stable digest for a durable raw-history prefix."""

    encoded = json.dumps(
        items,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def summary_item(summary: str, covered_through_run_id: str) -> TResponseInputItem:
    """Build the system item that represents one durable summary marker."""

    return {
        "role": "system",
        "content": f"Conversation summary through {covered_through_run_id}:\n{summary}",
    }


@dataclass(frozen=True, slots=True)
class HistoryView:
    """Validated summary anchor plus effective-history segments after it."""

    summary: str | None
    covered_runs: tuple[ConversationRun, ...]
    covered_through_run_id: str | None
    segments: tuple[ConversationSegment, ...]
    degraded_alignment: bool


def estimate(request: CompactionRequest, items: list[TResponseInputItem]) -> PromptTokenEstimate:
    """Estimate the exact candidate prompt using the Task 2 estimator."""

    prompt_items = tuple(item for item in items if isinstance(item, Mapping))
    current_input = (
        request.agent_input
        if isinstance(request.agent_input, str)
        else json.dumps(request.agent_input, ensure_ascii=False, separators=(",", ":"), default=str)
    )
    return request.estimator.estimate(
        CandidateChatCompletionsPrompt(
            shape=request.prompt_shape,
            session_items=prompt_items,
            current_input=current_input,
            resolved_instructions=request.resolved_instructions,
        ),
        request.budget,
    )


def build_history_view(
    record: Mapping[str, Any],
    snapshot: Any,
    groups: list[tuple[TResponseInputItem, ...]],
) -> HistoryView:
    """Validate a summary marker before aligning only its raw suffix."""

    records = terminal_runs(snapshot)
    if not record:
        runs = align_groups_to_records(groups, records)
        return HistoryView(
            summary=None,
            covered_runs=(),
            covered_through_run_id=None,
            segments=tuple(
                ConversationSegment((run.run_id,), run.items) for run in runs
            ),
            degraded_alignment=False,
        )
    summary, covered_index, covered_count = validate_summary_anchor(record, records, groups)
    covered_records = records[: covered_index + 1]
    covered_runs = [
        ConversationRun(run.run_id, group)
        for run, group in zip(covered_records, groups[:covered_count], strict=True)
    ]
    suffix_groups = groups[covered_count:]
    suffix_records = records[covered_index + 1 :]
    try:
        suffix = align_groups_to_records(suffix_groups, suffix_records)
    except HistoryAlignmentError:
        return HistoryView(
            summary=summary,
            covered_runs=tuple(covered_runs),
            covered_through_run_id=covered_runs[-1].run_id,
            segments=(ConversationSegment((), tuple(flatten_groups(suffix_groups))),),
            degraded_alignment=True,
        )
    return HistoryView(
        summary=summary,
        covered_runs=tuple(covered_runs),
        covered_through_run_id=covered_runs[-1].run_id,
        segments=tuple(ConversationSegment((run.run_id,), run.items) for run in suffix),
        degraded_alignment=False,
    )


def validate_summary_anchor(
    record: Mapping[str, Any],
    records: list[Any],
    groups: list[tuple[TResponseInputItem, ...]],
) -> tuple[str, int, int]:
    """Validate a durable summary against its declared raw-history anchor."""

    summary = record.get("summary")
    covered_ids = record.get("covered_run_ids")
    covered_through = record.get("covered_through_run_id")
    if record.get("schema_version") != "1.0":
        raise ValueError("conversation summary schema_version is invalid")
    if not isinstance(summary, str) or not summary:
        raise ValueError("conversation summary is missing text")
    if not isinstance(covered_ids, list) or not covered_ids:
        raise ValueError("conversation summary covered_run_ids are invalid")
    if not isinstance(covered_through, str) or covered_ids[-1] != covered_through:
        raise ValueError("conversation summary coverage is invalid")
    if record.get("summary_digest") != hashlib.sha256(summary.encode("utf-8")).hexdigest():
        raise ValueError("conversation summary summary_digest is invalid")
    covered_count = len(covered_ids)
    if len(groups) < covered_count or len(records) < covered_count:
        raise ValueError("conversation summary coverage is not in durable history")
    prefix = records[:covered_count]
    if [run.run_id for run in prefix] != covered_ids:
        raise ValueError("conversation summary covered_run_ids are invalid")
    if digest_items(flatten_groups(groups[:covered_count])) != record.get(
        "covered_history_digest"
    ):
        raise ValueError("conversation summary covered_history_digest is invalid")
    return summary, covered_count - 1, covered_count


def effective_items(
    view: HistoryView,
    segments: list[ConversationSegment],
) -> list[TResponseInputItem]:
    """Return the summary-marker view followed by retained complete segments."""

    if view.summary is None or view.covered_through_run_id is None:
        return flatten_segments(segments)
    return [
        summary_item(view.summary, view.covered_through_run_id),
        *flatten_segments(segments),
    ]


def summary_record(summary: str, covered_runs: list[ConversationRun]) -> dict[str, Any]:
    """Build the durable marker record for a newly created or shortened summary."""

    covered_through = covered_runs[-1].run_id
    return {
        "schema_version": "1.0",
        "summary": summary,
        "summary_digest": hashlib.sha256(summary.encode("utf-8")).hexdigest(),
        "covered_through_run_id": covered_through,
        "covered_run_ids": [run.run_id for run in covered_runs],
        "covered_history_digest": digest_items(flatten(covered_runs)),
    }


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
