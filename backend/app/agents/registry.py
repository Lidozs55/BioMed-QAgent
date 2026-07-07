"""Agent 注册表 — 阶段 Agent 的发现与实例化。

用法：
    @AgentRegistry.register
    class SearchAgent(BaseAgent):
        name = "search"
        ...

    agent = AgentRegistry.get("search", llm=..., tools=..., store=...)
    records, ctx = await agent.execute(task, records, context, progress)
"""
from __future__ import annotations

import logging

from app.agents.base import BaseAgent

logger = logging.getLogger(__name__)


class AgentRegistry:
    """阶段 Agent 注册表。"""

    # name → Agent 类
    _agents: dict[str, type[BaseAgent]] = {}

    @classmethod
    def register(cls, agent_class: type[BaseAgent]) -> type[BaseAgent]:
        """装饰器：注册 Agent 类。

        用法：
            @AgentRegistry.register
            class SearchAgent(BaseAgent): ...
        """
        if not getattr(agent_class, "name", None):
            raise ValueError(f"Agent 类缺少 name 属性: {agent_class}")
        cls._agents[agent_class.name] = agent_class
        logger.debug("已注册 Agent: %s", agent_class.name)
        return agent_class

    @classmethod
    def get(cls, name: str, **kwargs) -> BaseAgent | None:
        """按名称实例化 Agent。

        kwargs 透传给 Agent.__init__（llm/tools/store）。
        未注册时返回 None。
        """
        agent_class = cls._agents.get(name)
        if agent_class is None:
            return None
        return agent_class(**kwargs)

    @classmethod
    def list_agents(cls) -> list[dict]:
        """列出所有已注册 Agent 的元数据。"""
        return [
            {"name": name, "description": getattr(cls_, "description", "")}
            for name, cls_ in cls._agents.items()
        ]

    @classmethod
    def has(cls, name: str) -> bool:
        return name in cls._agents


def register_all_agents() -> None:
    """导入所有 Agent 模块，触发 @AgentRegistry.register 装饰器。

    在 Orchestrator 初始化时调用，确保 PIPELINE 各阶段 Agent 已注册。
    """
    # 导入即触发注册（模块顶层有 @AgentRegistry.register）
    import app.agents.search  # noqa: F401
    import app.agents.acquire  # noqa: F401
    import app.agents.parser  # noqa: F401
    import app.agents.cleaner  # noqa: F401
    import app.agents.analysis  # noqa: F401
    import app.agents.reviewer  # noqa: F401
    logger.info("已注册 %d 个阶段 Agent: %s",
                len(AgentRegistry._agents),
                list(AgentRegistry._agents.keys()))
