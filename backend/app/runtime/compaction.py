"""Durable conversation compaction without mutating raw SDK session history."""

from __future__ import annotations

import copy
import hashlib
import json
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any

from agents import Agent, Runner
from agents.items import TResponseInputItem
from agents.memory import Session

from app.domain.contracts import (
    ConversationCompactedPayload,
    RunStatus,
    WarningPayload,
)


COMPACTION_CHARACTER_THRESHOLD = 60_000
RAW_RUNS_AFTER_COMPACTION = 5
COMPACTION_FAILURE_RUNS = 20

_TERMINAL_RUN_STATUSES = {
    RunStatus.COMPLETED,
    RunStatus.FAILED,
    RunStatus.CANCELLED,
    RunStatus.INTERRUPTED,
}

Summarize = Callable[..., Awaitable[str]]
EventEmitter = Callable[[object], Awaitable[object]]


@dataclass(frozen=True, slots=True)
class _ConversationRun:
    run_id: str
    items: tuple[TResponseInputItem, ...]


@dataclass(frozen=True, slots=True)
class CompactionPreparation:
    """The SDK session view to use for the upcoming Run."""

    session: Session
    compacted: bool = False
    fallback: bool = False


class _EffectiveSession:
    """Override reads for one Run while delegating every durable mutation."""

    def __init__(
        self,
        underlying: Session,
        effective_items: list[TResponseInputItem],
    ) -> None:
        self._underlying = underlying
        self._effective_items = copy.deepcopy(effective_items)
        self.session_settings = getattr(underlying, "session_settings", None)

    async def get_items(self, limit: int | None = None) -> list[TResponseInputItem]:
        selected = (
            self._effective_items
            if limit is None
            else self._effective_items[-limit:]
            if limit
            else []
        )
        return copy.deepcopy(selected)

    async def add_items(self, items: list[TResponseInputItem]) -> None:
        await self._underlying.add_items(items)

    async def pop_item(self) -> TResponseInputItem | None:
        return await self._underlying.pop_item()

    async def clear_session(self) -> None:
        await self._underlying.clear_session()


def _content_text(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(
            _content_text(part.get("text", part.get("content", "")))
            if isinstance(part, Mapping)
            else _content_text(part)
            for part in value
        )
    if value is None:
        return ""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _item_value(item: object, name: str, default: object = None) -> object:
    if isinstance(item, Mapping):
        return item.get(name, default)
    return getattr(item, name, default)


def _item_history_text(item: TResponseInputItem) -> str:
    for key in ("content", "output", "arguments"):
        value = _item_value(item, key)
        if value is not None:
            return _content_text(value)
    return json.dumps(item, ensure_ascii=False, separators=(",", ":"), default=str)


def _split_session_runs(
    items: list[TResponseInputItem],
) -> list[tuple[TResponseInputItem, ...]]:
    groups: list[list[TResponseInputItem]] = []
    for item in items:
        if _item_value(item, "role") == "user":
            groups.append([])
        if groups:
            groups[-1].append(item)
    return [tuple(group) for group in groups if group]


def _align_runs(snapshot, items: list[TResponseInputItem]) -> list[_ConversationRun]:
    groups = _split_session_runs(items)
    records = [run for run in snapshot.runs if run.status in _TERMINAL_RUN_STATUSES]
    aligned: list[_ConversationRun] = []
    record_offset = 0
    for group in groups:
        user_input = _content_text(_item_value(group[0], "content", "")).strip()
        for index in range(record_offset, len(records)):
            record = records[index]
            if record.input == user_input:
                aligned.append(_ConversationRun(record.run_id, group))
                record_offset = index + 1
                break
    return aligned


def _flatten(runs: list[_ConversationRun]) -> list[TResponseInputItem]:
    return [copy.deepcopy(item) for run in runs for item in run.items]


def _history_characters(runs: list[_ConversationRun]) -> int:
    return sum(len(_item_history_text(item)) for run in runs for item in run.items)


def _digest_items(items: list[TResponseInputItem]) -> str:
    encoded = json.dumps(
        items,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _summary_item(summary: str, covered_through_run_id: str) -> TResponseInputItem:
    return {
        "role": "system",
        "content": (
            f"Conversation summary through {covered_through_run_id}:\n{summary}"
        ),
    }


async def _summarize_with_model(
    *,
    model_handle: object,
    history: list[TResponseInputItem],
    previous_summary: str | None,
) -> str:
    summarizer = Agent(
        name="ConversationSummarizer",
        instructions=(
            "Summarize the conversation faithfully for continuation. Preserve user "
            "goals, biomedical entities, tool findings, decisions, warnings, and "
            "unresolved work. Do not call tools."
        ),
        tools=[],
        model=model_handle,
    )
    payload = {
        "previous_summary": previous_summary,
        "history": history,
    }
    result = await Runner.run(
        summarizer,
        json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=str),
        max_turns=1,
    )
    summary = result.final_output
    if not isinstance(summary, str) or not summary.strip():
        raise ValueError("conversation summarizer returned no text")
    return summary.strip()


class ConversationCompactor:
    """Prepare bounded effective history before one manager-owned Agent Run."""

    def __init__(
        self,
        repository,
        *,
        summarize: Summarize = _summarize_with_model,
        character_threshold: int = COMPACTION_CHARACTER_THRESHOLD,
    ) -> None:
        self._repository = repository
        self._summarize = summarize
        self._character_threshold = character_threshold

    async def prepare(
        self,
        task_id: str,
        *,
        model_handle: object,
        emit: EventEmitter,
        session: Session | None = None,
    ) -> CompactionPreparation:
        task_session = session or self._repository.task_session(task_id)
        items = await task_session.get_items()
        snapshot = await self._repository.get_snapshot(task_id)
        if snapshot is None:
            raise LookupError(task_id)
        summary_record = await self._repository.load_conversation_summary(task_id)
        runs = _align_runs(snapshot, items)
        previous_summary, covered_index = self._summary_coverage(summary_record, runs)
        unsummarized = runs[covered_index + 1 :]

        if (
            _history_characters(unsummarized) <= self._character_threshold
            or len(unsummarized) <= RAW_RUNS_AFTER_COMPACTION
        ):
            if previous_summary is None:
                return CompactionPreparation(session=task_session)
            effective = [
                _summary_item(
                    previous_summary,
                    str(summary_record["covered_through_run_id"]),
                ),
                *_flatten(unsummarized),
            ]
            return CompactionPreparation(
                session=_EffectiveSession(task_session, effective)
            )

        to_cover = unsummarized[:-RAW_RUNS_AFTER_COMPACTION]
        retained = unsummarized[-RAW_RUNS_AFTER_COMPACTION:]
        try:
            summary = await self._summarize(
                model_handle=model_handle,
                history=_flatten(to_cover),
                previous_summary=previous_summary,
            )
            if not isinstance(summary, str) or not summary.strip():
                raise ValueError("conversation summarizer returned no text")
            summary = summary.strip()
            covered_through = to_cover[-1].run_id
            all_covered = runs[: covered_index + 1] + to_cover
            summary_digest = hashlib.sha256(summary.encode("utf-8")).hexdigest()
            record = {
                "schema_version": "1.0",
                "summary": summary,
                "summary_digest": summary_digest,
                "covered_through_run_id": covered_through,
                "covered_run_ids": [run.run_id for run in all_covered],
                "covered_history_digest": _digest_items(_flatten(all_covered)),
            }
            await self._repository.save_conversation_summary(task_id, record)
        except Exception as error:
            await emit(
                WarningPayload(
                    message=f"conversation compaction failed: {error}",
                    code="compaction_failed",
                )
            )
            fallback_runs = unsummarized[-COMPACTION_FAILURE_RUNS:]
            effective: list[TResponseInputItem] = []
            if previous_summary is not None:
                effective.append(
                    _summary_item(
                        previous_summary,
                        str(summary_record["covered_through_run_id"]),
                    )
                )
            effective.extend(_flatten(fallback_runs))
            return CompactionPreparation(
                session=_EffectiveSession(task_session, effective),
                fallback=True,
            )

        await emit(
            ConversationCompactedPayload(
                covered_through_run_id=record["covered_through_run_id"],
                summary_digest=record["summary_digest"],
            )
        )
        effective = [
            _summary_item(summary, covered_through),
            *_flatten(retained),
        ]
        return CompactionPreparation(
            session=_EffectiveSession(task_session, effective),
            compacted=True,
        )

    @staticmethod
    def _summary_coverage(
        record: Mapping[str, Any],
        runs: list[_ConversationRun],
    ) -> tuple[str | None, int]:
        if not record:
            return None, -1
        summary = record.get("summary")
        covered_run_id = record.get("covered_through_run_id")
        if not isinstance(summary, str) or not summary:
            raise ValueError("conversation summary is missing text")
        if not isinstance(covered_run_id, str) or not covered_run_id:
            raise ValueError("conversation summary is missing coverage")
        for index, run in enumerate(runs):
            if run.run_id == covered_run_id:
                return summary, index
        raise ValueError("conversation summary coverage is not in durable history")


__all__ = [
    "COMPACTION_CHARACTER_THRESHOLD",
    "COMPACTION_FAILURE_RUNS",
    "RAW_RUNS_AFTER_COMPACTION",
    "CompactionPreparation",
    "ConversationCompactor",
]
