"""技能注册表 — SkillManifest 的注册、查询、发现。

用法：
    from app.skills.manifest import SkillManifest
    from app.skills.registry import SkillRegistry

    manifest = SkillManifest(skill_id="pubmed", name="PubMed Search", ...)
    SkillRegistry.register_manifest(manifest, executor=func)

    skills = SkillRegistry.list_skills(category="datasources")
"""
from __future__ import annotations

import logging
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from app.skills.manifest import SkillManifest

logger = logging.getLogger(__name__)


class SkillRegistry:
    """Skill 注册表 — SkillManifest 的注册、查询、发现。"""

    # skill_id → dict with 'manifest' and 'executor' keys
    _entries: dict[str, dict[str, Any]] = {}

    # ── 注册 ─────────────────────────────────────────────────

    @classmethod
    def register_manifest(
        cls,
        manifest: SkillManifest,
        executor=None,
    ) -> None:
        """注册一个 SkillManifest，可附带 executor 回调。

        如果 skill_id 已存在，覆盖旧条目并记录 warning。
        """
        if manifest.skill_id in cls._entries:
            logger.warning(
                "skill_id %r 已注册，将覆盖旧条目", manifest.skill_id,
            )
        cls._entries[manifest.skill_id] = {
            "manifest": manifest,
            "executor": executor,
        }
        logger.debug("已注册 skill: %s (category=%s)", manifest.skill_id, manifest.category)

    # ── 查询 ─────────────────────────────────────────────────

    @classmethod
    def get(cls, skill_id: str) -> SkillManifest | None:
        """按 skill_id 获取 SkillManifest。"""
        entry = cls._entries.get(skill_id)
        return entry["manifest"] if entry else None

    @classmethod
    def get_executor(cls, skill_id: str):
        """按 skill_id 获取 executor 回调。"""
        entry = cls._entries.get(skill_id)
        return entry["executor"] if entry else None

    # ── 列出 ─────────────────────────────────────────────────

    @classmethod
    def list_skills(cls, category: str | None = None) -> list[SkillManifest]:
        """列出所有已注册清单，可按 category 过滤。"""
        manifests = [e["manifest"] for e in cls._entries.values()]
        if category is not None:
            manifests = [m for m in manifests if m.category == category]
        return manifests

    @classmethod
    def list_categories(cls) -> list[str]:
        """列出所有已注册清单中出现的唯一 category。"""
        return sorted({m.category for m in cls.list_skills()})

    # ── 工具方法 ─────────────────────────────────────────────

    @classmethod
    def has(cls, skill_id: str) -> bool:
        """检查 skill_id 是否已注册。"""
        return skill_id in cls._entries

    @classmethod
    def count(cls) -> int:
        """已注册 skills 总数。"""
        return len(cls._entries)


def get_skill_registry() -> type[SkillRegistry]:
    """获取 SkillRegistry 单例。

    由于 SkillRegistry 使用 classmethod 接口，
    直接返回 SkillRegistry 类本身即可。
    """
    return SkillRegistry
