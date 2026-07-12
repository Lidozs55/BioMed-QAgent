"""Skill 仓库 — 可发现、可选择、按需加载的能力包。

导出 SkillDef、SkillCategory、SkillRegistry 和 build_agent_config。
"""
from app.skills.registry import (
    HARD_MAX_TOOLS,
    SUGGESTED_MAX_TOOLS,
    SkillCategory,
    SkillDef,
    SkillRegistry,
    build_agent_config,
    skill_registry,
)

__all__ = [
    "HARD_MAX_TOOLS",
    "SUGGESTED_MAX_TOOLS",
    "SkillCategory",
    "SkillDef",
    "SkillRegistry",
    "build_agent_config",
    "skill_registry",
]
