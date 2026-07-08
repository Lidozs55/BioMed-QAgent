"""技能层 — SkillManifest 注册、检索的统一 facade。

所有技能通过 SkillRegistry 注册，提供统一的查询（list/get/search）
接口，供 API 路由和 LLM 工具选择使用。
"""
from __future__ import annotations

from app.skills.definitions import register_all_skills
from app.skills.manifest import SkillInputField, SkillManifest, SkillOutputField
from app.skills.registry import SkillRegistry, get_skill_registry
from app.skills.retriever import SkillRetriever

__all__ = [
    "SkillManifest",
    "SkillInputField",
    "SkillOutputField",
    "SkillRegistry",
    "get_skill_registry",
    "SkillRetriever",
    "register_all_skills",
]
