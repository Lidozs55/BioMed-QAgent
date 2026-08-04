"""Durable-session helpers for conversation compaction."""

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

from .compaction_types import HistoryAlignmentError

_TERMINAL_RUN_STATUSES = {
    RunStatus.COMPLETED,
    RunStatus.FAILED,
    RunStatus.CANCELLED,
    RunStatus.INTERRUPTED,
}


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
