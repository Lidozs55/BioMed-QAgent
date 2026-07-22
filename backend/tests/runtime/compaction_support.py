"""Shared deterministic fixtures for compaction contract tests."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime

from app.domain.contracts import RunRecord, RunStatus, TaskMode, TaskSnapshot, TaskSummary
from app.model_config.context_budget import ContextBudget
from app.model_config.token_estimation import (
    ChatCompletionsPromptShape,
    ChatCompletionsStructuralPolicy,
    ConservativeUtf8TokenCounter,
    PromptTokenEstimator,
)
from app.runtime.compaction import CompactionRequest

NOW = datetime(2026, 7, 14, tzinfo=UTC)


def completed_snapshot(task_id: str, count: int) -> TaskSnapshot:
    """Return deterministic terminal Run records matching ``conversation_items``."""

    return TaskSnapshot(
        task=TaskSummary(
            task_id=task_id,
            mode=TaskMode.AGENT,
            title=task_id,
            status=RunStatus.COMPLETED,
            created_at=NOW,
            updated_at=NOW,
        ),
        runs=[
            RunRecord(
                run_id=f"run_{index}",
                task_id=task_id,
                request_id=f"request_{index}",
                status=RunStatus.COMPLETED,
                input=f"question {index}",
                created_at=NOW,
                updated_at=NOW,
                started_at=NOW,
                finished_at=NOW,
            )
            for index in range(count)
        ],
    )


def conversation_items(count: int, answer: str) -> list[dict[str, str]]:
    """Build complete raw user/assistant exchanges with stable prompt text."""

    return [
        item
        for index in range(count)
        for item in (
            {"role": "user", "content": f"question {index}"},
            {"role": "assistant", "content": answer},
        )
    ]


def history_digest(items: list[dict[str, str]]) -> str:
    """Return the summary-marker digest for an exact raw prefix."""

    encoded = json.dumps(
        items,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def valid_summary_record(
    items: list[dict[str, str]],
    covered_index: int,
    summary: str = "existing summary",
) -> dict[str, object]:
    """Return a marker validated against the requested complete-Run prefix."""

    covered_items = items[: (covered_index + 1) * 2]
    return {
        "schema_version": "1.0",
        "summary": summary,
        "summary_digest": hashlib.sha256(summary.encode("utf-8")).hexdigest(),
        "covered_through_run_id": f"run_{covered_index}",
        "covered_run_ids": [f"run_{index}" for index in range(covered_index + 1)],
        "covered_history_digest": history_digest(covered_items),
    }


def budgeted_request(
    trigger_tokens: int = 1_000,
    target_tokens: int = 500,
) -> CompactionRequest:
    """Return one deterministic local-only Task 3 compaction request."""

    return CompactionRequest(
        agent_input="next question",
        prompt_shape=ChatCompletionsPromptShape(
            instructions="resolved instructions",
            serialized_tool_schemas=(),
            policy=ChatCompletionsStructuralPolicy(),
        ),
        resolved_instructions="resolved instructions",
        budget=ContextBudget(
            context_window=300_000,
            max_output_tokens=1_000,
            safety_reserve_tokens=1_000,
            trigger_tokens=trigger_tokens,
            target_tokens=target_tokens,
            provider_origin="https://provider.example",
            model_name="model-a",
            tokenizer_kind="conservative",
            calibration_margin_tokens=0,
        ),
        estimator=PromptTokenEstimator(ConservativeUtf8TokenCounter()),
    )
