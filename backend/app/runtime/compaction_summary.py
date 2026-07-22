"""Model-backed summary generation for conversation compaction."""

from __future__ import annotations

import json

from agents import Agent, ModelSettings, Runner
from agents.items import TResponseInputItem
from agents.stream_events import RawResponsesStreamEvent

from .compaction_types import ConversationSummarizerTruncatedError


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
