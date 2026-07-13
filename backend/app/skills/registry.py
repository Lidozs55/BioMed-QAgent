"""Skill 注册表 — 可发现、可选择、按需加载的能力包。

Skill = instructions 片段 + 工具组合 + 支持的数据源 + 约束。
Skill 被加载后，Tool 仍由 OpenAI Agents SDK 直接执行，不经过额外执行引擎。
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from enum import Enum

logger = logging.getLogger(__name__)

# 每个 Skill 建议暴露的工具数上限；超过 HARD_MAX 强制评审
SUGGESTED_MAX_TOOLS = 20
HARD_MAX_TOOLS = 30


class SkillCategory(str, Enum):
    """Skill 四大类别。"""

    DISCOVERY = "discovery"
    ACQUISITION = "acquisition"
    PROCESSING = "processing"
    ANALYSIS = "analysis"


@dataclass
class SkillDef:
    """Skill 定义。

    Attributes:
        name: 唯一名称。
        category: 所属类别（discovery/acquisition/processing/analysis）。
        description: 供 Agent 判断何时使用此 Skill；简洁，不含开发日志。
        instructions: 加载时附加给 Agent 的说明片段。
        tools: 允许调用的 SDK Function Tool 实例列表。
        supported_sources: 支持的数据源或网站标识（如 "geo", "pubmed"）。
        version: Skill 版本号。
        enabled: 是否可被加载。
        input_model: 可选输入模型（pydantic BaseModel）。
        output_model: 可选输出模型。
        examples: 可选示例列表。
    """

    name: str
    category: SkillCategory
    description: str
    instructions: str = ""
    tools: list = field(default_factory=list)
    supported_sources: list[str] = field(default_factory=list)
    version: str = "0.1.0"
    enabled: bool = True
    input_model: type | None = None
    output_model: type | None = None
    examples: list[dict] = field(default_factory=list)

    def __post_init__(self) -> None:
        """注册时校验工具数量。"""
        count = len(self.tools)
        if count > HARD_MAX_TOOLS:
            raise ValueError(
                f"Skill '{self.name}' 暴露 {count} 个 Tool，超过上限 "
                f"{HARD_MAX_TOOLS}，需拆分或重新评审"
            )
        if count > SUGGESTED_MAX_TOOLS:
            logger.warning(
                "Skill '%s' 暴露 %d 个 Tool，超过建议值 %d，建议评估是否拆分",
                self.name,
                count,
                SUGGESTED_MAX_TOOLS,
            )


class SkillRegistry:
    """Skill 注册表 — 支持注册、查询、按类别/数据源筛选和按需加载。"""

    def __init__(self) -> None:
        self._skills: dict[str, SkillDef] = {}

    def register(self, skill: SkillDef) -> None:
        """注册一个 Skill。同名覆盖。"""
        self._skills[skill.name] = skill

    def get(self, name: str) -> SkillDef | None:
        """按名称查询 Skill。"""
        return self._skills.get(name)

    def names(self) -> list[str]:
        """列出所有已注册 Skill 名称。"""
        return list(self._skills.keys())

    def list_by_category(self, category: SkillCategory) -> list[SkillDef]:
        """按类别筛选 Skill。"""
        return [s for s in self._skills.values() if s.category == category]

    def list_by_source(self, source: str) -> list[SkillDef]:
        """按支持的数据源筛选 Skill。"""
        return [s for s in self._skills.values() if source in s.supported_sources]

    def list_enabled(self) -> list[SkillDef]:
        """列出所有 enabled 的 Skill。"""
        return [s for s in self._skills.values() if s.enabled]

    def get_acquisition_skills(
        self, user_sources: list[str] | None = None
    ) -> list[SkillDef]:
        """根据用户选择的数据库过滤 acquisition Skill。

        Args:
            user_sources: 用户允许的数据源列表。None 表示加载全部默认 acquisition Skill。
        """
        acq_skills = [
            s for s in self._skills.values()
            if s.category == SkillCategory.ACQUISITION and s.enabled
        ]
        if user_sources is None:
            return acq_skills
        return [
            s for s in acq_skills
            if any(src in user_sources for src in s.supported_sources)
        ]


def build_agent_config(
    skills: list[SkillDef],
) -> tuple[str, list]:
    """合并选中的 Skill，返回 (instructions_suffix, tools) 供 create_agent 使用。

    - 合并各 Skill 的 instructions 片段；
    - 合并并按工具名去重 tools；
    - 只加载 enabled 的 Skill。
    """
    active = [s for s in skills if s.enabled]
    instructions_parts = [s.instructions for s in active if s.instructions]
    merged_instructions = "\n\n".join(instructions_parts)

    seen: set[str] = set()
    merged_tools: list = []
    for skill in active:
        for tool in skill.tools:
            tool_name = getattr(tool, "name", str(tool))
            if tool_name not in seen:
                seen.add(tool_name)
                merged_tools.append(tool)
    return merged_instructions, merged_tools


# 全局注册表
skill_registry = SkillRegistry()
