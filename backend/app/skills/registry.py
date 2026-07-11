"""Skill 注册表 — 可复用能力包（prompt 片段 + 工具组合 + 约束）。

后续实现：Skill 可动态加载到 Agent 的 instructions 中。
当前为骨架占位。
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class SkillDef:
    """Skill 定义。"""
    name: str
    prompt_suffix: str = ""
    tools: list[str] = field(default_factory=list)
    constraints: list[str] = field(default_factory=list)


class SkillRegistry:
    """Skill 注册表。"""

    def __init__(self) -> None:
        self._skills: dict[str, SkillDef] = {}

    def register(self, skill: SkillDef) -> None:
        self._skills[skill.name] = skill

    def get(self, name: str) -> SkillDef | None:
        return self._skills.get(name)

    def list(self) -> list[str]:
        return list(self._skills.keys())


# 全局注册表
skill_registry = SkillRegistry()
