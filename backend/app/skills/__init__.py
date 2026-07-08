"""技能层 — SkillManifest 注册、检索、执行、评估的统一 facade。

所有技能通过 SkillRegistry 注册，提供统一的查询（list/get/search）
和执行接口，供 API 路由和 LLM 工具选择使用。
"""
from __future__ import annotations

from app.skills.candidate import CandidateRunner
from app.skills.definitions import register_all_skills
from app.skills.evaluator import EvaluationReport, SkillEvaluator
from app.skills.executor import SkillExecutor, SkillResult
from app.skills.manifest import SkillInputField, SkillManifest, SkillOutputField
from app.skills.promotion import PromotionManager
from app.skills.registry import SkillRegistry, get_skill_registry
from app.skills.repair import SkillRepairAgent
from app.skills.retriever import SkillRetriever

__all__ = [
    "SkillManifest",
    "SkillInputField",
    "SkillOutputField",
    "SkillRegistry",
    "get_skill_registry",
    "SkillRetriever",
    "SkillExecutor",
    "SkillResult",
    "SkillEvaluator",
    "EvaluationReport",
    "register_all_skills",
    "SkillRepairAgent",
    "CandidateRunner",
    "PromotionManager",
]
