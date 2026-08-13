"""Restricted SDK agents used by the managed child-agent Supervisor."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from agents import Agent, RunContextWrapper, Runner
from agents.exceptions import MaxTurnsExceeded

from app.agent_loop.agent import build_sdk_model_settings
from app.agent_loop.context import RunContext
from app.agent_loop.model import get_active_model_settings, get_model
from app.domain.contracts import (
    SubagentErrorCode,
    SubagentRequest,
    SubagentResult,
    SubagentStatus,
    SubagentType,
)
from app.model_config import RunModelSettings
from app.skills.builtin import builtin_skill_records, load_builtin_tools
from app.skills.categories import SkillCategory
from app.subagents.result_safety import sanitize_subagent_result

CHILD_AGENT_MAX_TURNS = 30


def resolve_child_agent_max_turns(
    model_settings: RunModelSettings | None = None,
) -> int:
    """Return the configured child-agent max_turns (default 30)."""

    from app.model_settings import get_runtime_limits

    if model_settings is not None:
        return model_settings.runtime_limits.child_agent_max_turns
    return get_runtime_limits().child_agent_max_turns


def _make_child_instructions(
    base: str,
) -> Callable[[RunContextWrapper[RunContext], Agent[RunContext]], Awaitable[str]]:
    """构造子代理动态 instructions，注入父任务已完成检索清单。

    Reuses the main-agent formatter (docs/REVIEW_2026-07-31 §4.3 C1): the
    child's seeded query_log + query_log_summary render as a
    "已完成检索（勿重复）" section so a re-dispatched child does not repeat
    the parent's searches.
    """

    from app.agent_loop.agent import resolve_agent_instructions

    async def _fn(
        ctx: RunContextWrapper[RunContext],
        _agent: Agent[RunContext],
    ) -> str:
        return resolve_agent_instructions(base, ctx.context)

    return _fn

_SOURCE_RESEARCH_INSTRUCTIONS = """\
You are a bounded source-research child agent. Research only the delegated
objective through the direct data-source tools and guarded crawler available to you.
Report concise, verifiable findings. Do not build final artifacts, invoke a pipeline,
or delegate work.
"""


@dataclass(slots=True)
class _ChildSession:
    """Small independent SDK session; it never shares parent conversation state."""

    session_id: str
    _items: list[Any] = field(default_factory=list)

    async def get_items(self, limit: int | None = None) -> list[Any]:
        if limit is None:
            return list(self._items)
        return list(self._items[-limit:])

    async def add_items(self, items: list[Any]) -> None:
        self._items.extend(items)

    async def pop_item(self) -> Any | None:
        return self._items.pop() if self._items else None

    async def clear_session(self) -> None:
        self._items.clear()


class ChildAgentFactory:
    """Create narrow child Agents from one immutable parent model snapshot."""

    def __init__(
        self,
        *,
        model_settings: RunModelSettings | None = None,
        disabled_databases: frozenset[str] = frozenset(),
        user_http_tools: list | None = None,
    ) -> None:
        self._model_settings = model_settings or get_active_model_settings()
        self._disabled_databases = disabled_databases
        self._user_http_tools = user_http_tools

    def build_source_research_agent(self) -> Agent:
        """Research children may discover sources directly; no recipe creation."""

        records = builtin_skill_records()
        allowed: set[str] = {
            tool_name
            for record in records.values()
            if record.category in {SkillCategory.DISCOVERY, SkillCategory.ACQUISITION}
            for tool_name in record.tool_names
        }
        disabled = {
            tool_name
            for name in self._disabled_databases
            if name in records
            for tool_name in records[name].tool_names
        }
        tools = [
            tool
            for tool in load_builtin_tools()
            if getattr(tool, "name", "") in allowed
            and getattr(tool, "name", "") not in disabled
        ]
        if self._user_http_tools:
            registered = {getattr(tool, "name", "") for tool in tools}
            for tool in self._user_http_tools:
                name = getattr(tool, "name", "")
                if name in registered:
                    continue
                registered.add(name)
                tools.append(tool)
        return Agent(
            name="SourceResearchAgent",
            instructions=_make_child_instructions(_SOURCE_RESEARCH_INSTRUCTIONS),
            tools=tools,
            model=get_model(self._model_settings),
            model_settings=build_sdk_model_settings(self._model_settings),
        )


class _ChildAgentRunner:
    def __init__(self, parent_context: RunContext, factory: ChildAgentFactory) -> None:
        self._parent_context = parent_context
        self._factory = factory

    def _sanitize_result(self, result: SubagentResult) -> SubagentResult:
        return sanitize_subagent_result(
            result,
            known_secrets=(self._parent_context.model_settings.api_key,),
        )

    async def _run_agent(
        self,
        request: SubagentRequest,
        *,
        subagent_id: str,
        agent: Agent,
    ) -> SubagentResult:
        child_context = self._parent_context.create_child_context(
            subagent_id,
            preferred_sources=([request.target_source] if request.target_source else None),
            parent_query_log=self._parent_context.query_log,
            parent_query_log_summary=self._parent_context.query_log_summary,
        )
        session = _ChildSession(session_id=f"subagent:{subagent_id}")
        model = agent.model
        try:
            result = await Runner.run(
                agent,
                request.objective,
                context=child_context,
                session=session,
                max_turns=resolve_child_agent_max_turns(
                    self._parent_context.model_settings,
                ),
            )
        except MaxTurnsExceeded as error:
            # 子代理轮次用尽：与其它失败区分，返回可恢复的
            # ``MAX_TURNS_EXCEEDED`` 错误码，supervisor/parent 可据此
            # 决定续派（附 query_log 摘要）而非当作内部错误丢弃。
            return SubagentResult(
                subagent_id=subagent_id,
                status=SubagentStatus.FAILED,
                summary="Child agent exceeded max_turns",
                source_asset_ids=child_context.source_asset_ids,
                recipe_id=child_context.recipe_id,
                warnings=child_context.child_warnings,
                error_code=SubagentErrorCode.MAX_TURNS_EXCEEDED,
                error_message=str(error) or type(error).__name__,
            )
        except asyncio.CancelledError:
            raise
        except Exception as error:
            return SubagentResult(
                subagent_id=subagent_id,
                status=SubagentStatus.FAILED,
                summary="Child agent failed",
                source_asset_ids=child_context.source_asset_ids,
                recipe_id=child_context.recipe_id,
                warnings=child_context.child_warnings,
                error_code=SubagentErrorCode.INTERNAL_ERROR,
                error_message=str(error) or type(error).__name__,
            )
        finally:
            close = getattr(model, "close", None)
            if callable(close):
                await close()

        output = getattr(result, "final_output", None)
        summary = output.strip() if isinstance(output, str) else "Child agent completed"
        if (
            request.agent_type is SubagentType.SOURCE_RESEARCH
            and not child_context.source_asset_ids
        ):
            return SubagentResult(
                subagent_id=subagent_id,
                status=SubagentStatus.FAILED,
                summary=summary or "Source research produced no verifiable asset",
                source_asset_ids=[],
                recipe_id=child_context.recipe_id,
                warnings=child_context.child_warnings,
                error_code=SubagentErrorCode.EXTRACTION_FAILED,
                error_message="source research completed without a source asset",
            )
        return SubagentResult(
            subagent_id=subagent_id,
            status=SubagentStatus.COMPLETED,
            summary=summary or "Child agent completed",
            source_asset_ids=child_context.source_asset_ids,
            recipe_id=child_context.recipe_id,
            warnings=child_context.child_warnings,
        )


class SourceResearchAgentRunner(_ChildAgentRunner):
    """Run source research in an isolated context and SDK session."""

    async def run(
        self,
        request: SubagentRequest,
        *,
        subagent_id: str,
        task_id: str,
        run_id: str,
    ) -> SubagentResult:
        del task_id, run_id
        if request.agent_type is not SubagentType.SOURCE_RESEARCH:
            raise ValueError("source runner received a non-source request")
        return self._sanitize_result(
            await self._run_agent(
                request,
                subagent_id=subagent_id,
                agent=self._factory.build_source_research_agent(),
            )
        )


class ManagedChildAgentRunner:
    """Dispatch each supervisor request to its only permitted child Agent."""

    def __init__(
        self,
        parent_context: RunContext,
        *,
        disabled_databases: frozenset[str] = frozenset(),
        user_http_tools: list | None = None,
    ) -> None:
        factory = ChildAgentFactory(
            model_settings=parent_context.model_settings,
            disabled_databases=disabled_databases,
            user_http_tools=user_http_tools,
        )
        self._source = SourceResearchAgentRunner(parent_context, factory)

    async def run(
        self,
        request: SubagentRequest,
        *,
        subagent_id: str,
        task_id: str,
        run_id: str,
    ) -> SubagentResult:
        if request.agent_type is SubagentType.SOURCE_RESEARCH:
            return await self._source.run(
                request,
                subagent_id=subagent_id,
                task_id=task_id,
                run_id=run_id,
            )
        raise ValueError(f"unsupported subagent type: {request.agent_type}")


__all__ = [
    "CHILD_AGENT_MAX_TURNS",
    "ChildAgentFactory",
    "ManagedChildAgentRunner",
    "SourceResearchAgentRunner",
]
