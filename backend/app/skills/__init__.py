"""Skill 能力包（Phase 2 后仅剩类别与内置直接工具收集）。

Skill 的 SOP 知识已迁移至 `.pi/skills/*/SKILL.md`；Python 侧只保留
legacy Agent 直接工具所需的模块级常量与收集函数。
"""

from __future__ import annotations

from app.skills.builtin import (
    BuiltinSkillRecord,
    builtin_skill_modules,
    builtin_skill_records,
    load_builtin_tools,
)
from app.skills.categories import SkillCategory

__all__ = [
    "SkillCategory",
    "BuiltinSkillRecord",
    "builtin_skill_modules",
    "builtin_skill_records",
    "load_builtin_tools",
]
