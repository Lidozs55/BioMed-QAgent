"""技能提升管理器 — 管理技能的自动提升/回滚和版本历史。

PromotionManager:
1. 比较候选 vs 原始评估报告
2. 候选优于原始 → promote（替换原 manifest）
3. 候选劣于原始 → rollback（丢弃候选，保留原版）
4. 维护版本历史（最近 5 个版本）
"""
from __future__ import annotations

import logging
from typing import Any

from app.skills.manifest import SkillManifest
from app.skills.evaluator import EvaluationReport
from app.skills.candidate import CandidateRunner
from app.skills.registry import SkillRegistry

logger = logging.getLogger(__name__)


class PromotionManager:
    """管理技能的自动提升和版本历史。"""

    # 版本历史: skill_id → [SkillManifest, ...]（最近 5 个版本）
    _version_history: dict[str, list[SkillManifest]] = {}
    MAX_HISTORY = 5

    @classmethod
    def evaluate_and_maybe_promote(
        cls,
        original_manifest: SkillManifest,
        original_report: EvaluationReport,
        candidate: SkillManifest,
        test_inputs: dict[str, Any],
        registry=None,
    ) -> dict:
        """评估候选技能并决定是否提升。

        流程：
        1. CandidateRunner.test_candidate(candidate, ...) → 候选评估报告
        2. CandidateRunner.compare(original, candidate_report) → 对比结果
        3. 如果 promotable → promote（替换）
        4. 否则 → rollback（丢弃）

        Returns:
            {
                "action": "promoted" | "rolled_back" | "no_change",
                "original_version": str,
                "new_version": str | None,
                "improvement": float,
                "detail": str
            }
        """
        if registry is None:
            registry = SkillRegistry

        # 1. 测试候选
        candidate_report = CandidateRunner.test_candidate(
            candidate=candidate,
            original_skill_id=original_manifest.skill_id,
            test_inputs=test_inputs,
            registry=registry,
        )

        # 2. 对比
        comparison = CandidateRunner.compare(original_report, candidate_report)

        # 3. 决定
        if comparison["promotable"] and candidate_report is not None:
            return cls._promote(
                registry=registry,
                original=original_manifest,
                candidate=candidate,
                improvement=comparison["improvement"],
                candidate_report=candidate_report,
            )
        else:
            return cls._rollback(
                original=original_manifest,
                candidate=candidate,
                improvement=comparison["improvement"],
                detail=comparison["detail"],
            )

    @classmethod
    def _promote(
        cls, registry, original: SkillManifest, candidate: SkillManifest,
        improvement: float, candidate_report: EvaluationReport
    ) -> dict:
        """提升候选为主要版本。"""
        # 保存到版本历史
        cls._save_to_history(original.skill_id, original)

        # 用候选替换原 skill（保持同一 skill_id）
        registry.update_manifest(original.skill_id, candidate)

        logger.info(
            "技能 %s 已提升: %s → %s (Δ=%+.4f)",
            original.skill_id, original.version, candidate.version, improvement,
        )

        return {
            "action": "promoted",
            "original_version": original.version or "1.0.0",
            "new_version": candidate.version,
            "improvement": improvement,
            "detail": f"提升成功: {candidate.version} (Δ={improvement:+.4f})",
        }

    @classmethod
    def _rollback(
        cls, original: SkillManifest, candidate: SkillManifest,
        improvement: float, detail: str
    ) -> dict:
        """丢弃候选，保留原版。"""
        logger.info(
            "技能 %s 候选 %s 未达提升标准 (Δ=%+.4f)，丢弃候选",
            original.skill_id, candidate.version, improvement,
        )

        return {
            "action": "rolled_back",
            "original_version": original.version or "1.0.0",
            "new_version": None,
            "improvement": improvement,
            "detail": f"丢弃候选 {candidate.version}: {detail}",
        }

    # ── 版本历史 ──────────────────────────────────────────────

    @classmethod
    def _save_to_history(cls, skill_id: str, manifest: SkillManifest) -> None:
        """保存版本到历史（FIFO，最多 MAX_HISTORY 个版本）。"""
        if skill_id not in cls._version_history:
            cls._version_history[skill_id] = []
        history = cls._version_history[skill_id]
        history.append(manifest)
        if len(history) > cls.MAX_HISTORY:
            cls._version_history[skill_id] = history[-cls.MAX_HISTORY:]

    @classmethod
    def get_history(cls, skill_id: str) -> list[SkillManifest]:
        """获取技能版本历史。"""
        return cls._version_history.get(skill_id, [])

    @classmethod
    def restore_version(cls, skill_id: str, version: str, registry=None) -> bool:
        """从版本历史恢复指定版本。"""
        history = cls.get_history(skill_id)
        for m in history:
            if m.version == version:
                if registry is None:
                    registry = SkillRegistry
                registry.update_manifest(skill_id, m)
                logger.info("技能 %s 已恢复到版本 %s", skill_id, version)
                return True
        logger.warning("技能 %s 未找到版本 %s（历史: %s）", skill_id, version, [m.version for m in history])
        return False
