"""Restricted SDK agents used by the managed child-agent Supervisor."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from agents import Agent, Runner

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
from app.skills.builtin import load_builtin_skill_descriptors
from app.skills.builtin.processing.create_skill import create_skill_tool
from app.skills.catalog import SkillCatalog
from app.skills.gateway import build_skill_gateway
from app.skills.registry import SkillCategory

CHILD_AGENT_MAX_TURNS = 10

_SOURCE_RESEARCH_INSTRUCTIONS = """\
You are a bounded source-research child agent. Research only the delegated
objective through the skills and guarded crawler available to you. Report concise,
verifiable findings. Do not build final artifacts, invoke a pipeline, or delegate work.
"""

_SKILL_BUILDER_INSTRUCTIONS = """\
You are a bounded workflow-recipe child agent. Investigate an evidenced capability
gap with the guarded crawler and create only declarative WorkflowRecipes through
create_skill. Do not build final artifacts, invoke a pipeline, or delegate work.
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
        catalog: SkillCatalog | None = None,
    ) -> None:
        self._model_settings = model_settings or get_active_model_settings()
        self._catalog = catalog or SkillCatalog(load_builtin_skill_descriptors())

    def build_source_research_agent(self) -> Agent:
        find_skill, invoke_skill = build_skill_gateway(self._source_catalog())
        return Agent(
            name="SourceResearchAgent",
            instructions=_SOURCE_RESEARCH_INSTRUCTIONS,
            tools=[find_skill, invoke_skill],
            model=get_model(self._model_settings),
            model_settings=build_sdk_model_settings(self._model_settings),
        )

    def build_skill_builder_agent(self) -> Agent:
        find_skill, invoke_skill = build_skill_gateway(self._builder_catalog())
        return Agent(
            name="SkillBuilderAgent",
            instructions=_SKILL_BUILDER_INSTRUCTIONS,
            tools=[find_skill, invoke_skill, create_skill_tool],
            model=get_model(self._model_settings),
            model_settings=build_sdk_model_settings(self._model_settings),
        )

    def _source_catalog(self) -> SkillCatalog:
        """Research children may discover sources but never create recipes."""

        return SkillCatalog(
            descriptor
            for descriptor in self._catalog.snapshot().skills.values()
            if descriptor.name != "create_skill"
            and descriptor.category in {SkillCategory.DISCOVERY, SkillCategory.ACQUISITION}
        )

    def _builder_catalog(self) -> SkillCatalog:
        """Recipe children can inspect sources but only mutate via create_skill."""

        return SkillCatalog(
            descriptor
            for descriptor in self._catalog.snapshot().skills.values()
            if descriptor.name == "create_skill"
            or descriptor.category in {SkillCategory.DISCOVERY, SkillCategory.ACQUISITION}
        )


class _ChildAgentRunner:
    def __init__(self, parent_context: RunContext, factory: ChildAgentFactory) -> None:
        self._parent_context = parent_context
        self._factory = factory

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
        )
        session = _ChildSession(session_id=f"subagent:{subagent_id}")
        model = agent.model
        try:
            result = await Runner.run(
                agent,
                request.objective,
                context=child_context,
                session=session,
                max_turns=CHILD_AGENT_MAX_TURNS,
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
        return await self._run_agent(
            request,
            subagent_id=subagent_id,
            agent=self._factory.build_source_research_agent(),
        )


class SkillBuilderAgentRunner(_ChildAgentRunner):
    """Run workflow-recipe work in an isolated context and SDK session."""

    async def run(
        self,
        request: SubagentRequest,
        *,
        subagent_id: str,
        task_id: str,
        run_id: str,
    ) -> SubagentResult:
        del task_id, run_id
        if request.agent_type is not SubagentType.SKILL_BUILDER:
            raise ValueError("skill builder received a non-builder request")
        return await self._run_agent(
            request,
            subagent_id=subagent_id,
            agent=self._factory.build_skill_builder_agent(),
        )


class ManagedChildAgentRunner:
    """Dispatch each supervisor request to its only permitted child Agent."""

    def __init__(self, parent_context: RunContext, catalog: SkillCatalog | None = None) -> None:
        factory = ChildAgentFactory(
            model_settings=parent_context.model_settings,
            catalog=catalog,
        )
        self._source = SourceResearchAgentRunner(parent_context, factory)
        self._skill_builder = SkillBuilderAgentRunner(parent_context, factory)

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
        if request.agent_type is SubagentType.SKILL_BUILDER:
            return await self._skill_builder.run(
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
    "SkillBuilderAgentRunner",
    "SourceResearchAgentRunner",
]
