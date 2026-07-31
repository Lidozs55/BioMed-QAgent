"""Main-Agent tools for delegating bounded research work to child agents."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext
from app.domain.contracts import (
    SubagentRecord,
    SubagentRequest,
    SubagentResult,
    generate_prefixed_uuid,
)


@dataclass(frozen=True, slots=True)
class DelegationHandles:
    """Queued child handles returned without waiting for child completion."""

    subagents: list[SubagentRecord]

    def model_dump(self, **_kwargs: Any) -> dict[str, object]:
        return {"subagents": [item.model_dump(mode="json") for item in self.subagents]}


@dataclass(frozen=True, slots=True)
class SubagentResults:
    """Terminal results returned by an explicit Main-Agent lookup."""

    subagents: list[SubagentResult]

    def model_dump(self, **_kwargs: Any) -> dict[str, object]:
        return {"subagents": [item.model_dump(mode="json") for item in self.subagents]}


async def delegate_research_impl(
    context: RunContext,
    requests: list[SubagentRequest],
    *,
    parent_tool_call_id: str | None = None,
) -> DelegationHandles:
    """Schedule a batch and immediately return its queued child handles."""

    if context.managed_run_id is None:
        raise RuntimeError("subagent delegation requires a managed run")
    runtime = context.subagent_runtime
    records = await runtime.supervisor.start_batch(
        task_id=context.task_id,
        run_id=context.managed_run_id,
        parent_tool_call_id=parent_tool_call_id or generate_prefixed_uuid("tool"),
        requests=requests,
        runner=runtime.runner,
        sink=runtime.event_sink,
    )
    context.record_delegated_subagents([record.subagent_id for record in records])
    return DelegationHandles(subagents=records)


async def get_subagent_results_impl(
    context: RunContext,
    subagent_ids: list[str],
) -> SubagentResults:
    """Wait for the requested managed children and return their typed results."""

    runtime = context.subagent_runtime
    if context.managed_run_id is None:
        raise RuntimeError("subagent result lookup requires a managed run")
    results: list[SubagentResult] = []
    for subagent_id in subagent_ids:
        context.require_delegated_subagent(subagent_id)
        results.append(await runtime.supervisor.wait(subagent_id))
    return SubagentResults(subagents=results)


async def cancel_subagent_impl(
    context: RunContext,
    subagent_id: str,
    *,
    reason: str | None = None,
) -> SubagentResult:
    """Cancel one managed child through the parent Run's Supervisor."""

    if context.managed_run_id is None:
        raise RuntimeError("subagent cancellation requires a managed run")
    runtime = context.subagent_runtime
    context.require_delegated_subagent(subagent_id)
    return await runtime.supervisor.cancel(subagent_id, reason=reason)


def _tool_call_id(context: RunContextWrapper[RunContext]) -> str:
    """Use the SDK call identity when exposed; retain a durable fallback."""

    for owner in (context, getattr(context, "tool_context", None)):
        for attribute in ("tool_call_id", "call_id"):
            value = getattr(owner, attribute, None)
            if isinstance(value, str) and value:
                return value
    return generate_prefixed_uuid("tool")


@function_tool(name_override="delegate_research", strict_mode=False)
async def delegate_research(
    ctx: RunContextWrapper[RunContext],
    requests: list[SubagentRequest],
) -> dict[str, object]:
    """Delegate source research or recipe-building requests to child agents."""

    result = await delegate_research_impl(
        ctx.context,
        requests,
        parent_tool_call_id=_tool_call_id(ctx),
    )
    return result.model_dump()


@function_tool(name_override="get_subagent_results", strict_mode=False)
async def get_subagent_results(
    ctx: RunContextWrapper[RunContext],
    subagent_ids: list[str],
) -> dict[str, object]:
    """Retrieve terminal results for one or more delegated child agents."""

    return (await get_subagent_results_impl(ctx.context, subagent_ids)).model_dump()


@function_tool(name_override="cancel_subagent", strict_mode=False)
async def cancel_subagent(
    ctx: RunContextWrapper[RunContext],
    subagent_id: str,
    reason: str | None = None,
) -> dict[str, object]:
    """Cancel a delegated child agent by handle."""

    return (
        await cancel_subagent_impl(ctx.context, subagent_id, reason=reason)
    ).model_dump(mode="json")


__all__ = [
    "DelegationHandles",
    "SubagentResults",
    "cancel_subagent",
    "cancel_subagent_impl",
    "delegate_research",
    "delegate_research_impl",
    "get_subagent_results",
    "get_subagent_results_impl",
]
