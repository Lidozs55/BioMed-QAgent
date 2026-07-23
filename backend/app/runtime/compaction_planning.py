"""Token-budget planning for durable conversation compaction."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from agents.items import TResponseInputItem

from app.model_config.token_estimation import CandidateChatCompletionsPrompt, PromptTokenEstimate

from .compaction_history import (
    ConversationRun,
    ConversationSegment,
    align_groups_to_records,
    digest_items,
    flatten,
    flatten_groups,
    flatten_segments,
    summary_item,
    terminal_runs,
)
from .compaction_types import CompactionRequest, HistoryAlignmentError


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
