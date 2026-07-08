"""候选技能测试器 — 对修复的候选 SkillManifest 进行沙盒执行和评估。

CandidateRunner:
1. 临时注册候选 SkillManifest（模拟 executor）
2. 用 SkillExecutor.execute() 执行候选
3. 用 SkillEvaluator.evaluate() 评估候选
4. 返回候选评估报告
"""
from __future__ import annotations

import logging
from typing import Any

from app.skills.manifest import SkillManifest
from app.skills.evaluator import EvaluationReport, SkillEvaluator
from app.skills.registry import SkillRegistry

logger = logging.getLogger(__name__)


class CandidateRunner:
    """测试候选技能性能，生成对比评估报告。"""

    @classmethod
    def test_candidate(
        cls,
        candidate: SkillManifest,
        original_skill_id: str,
        test_inputs: dict[str, Any],
        registry=None,
    ) -> EvaluationReport | None:
        """执行候选技能并返回评估报告。

        Args:
            candidate: 候选修复后的 SkillManifest
            original_skill_id: 原始技能 ID（用于获取原始 executor）
            test_inputs: 测试输入参数
            registry: SkillRegistry 类

        Returns:
            EvaluationReport 或 None（执行失败）
        """
        if registry is None:
            registry = SkillRegistry

        # 1. 获取原始 executor
        original_executor = registry.get_executor(original_skill_id)
        if original_executor is None:
            logger.warning("CandidateRunner: 原始技能 %s 无 executor", original_skill_id)
            return None

        # 2. 临时注册候选（使用原始 executor 模拟）
        temp_id = f"_candidate_{candidate.skill_id}"
        registry.register_manifest(candidate, executor=original_executor)

        try:
            # 3. 执行
            from app.skills.executor import SkillExecutor
            result = SkillExecutor.execute(
                skill_id=temp_id,
                inputs=test_inputs,
                registry=registry,
            )

            # 4. 评估
            expected_outputs = [f.name for f in candidate.outputs]
            report = SkillEvaluator.evaluate(
                skill_id=candidate.skill_id,
                result=result.data if result.success else None,
                expected_outputs=expected_outputs,
                provided_inputs=test_inputs,
                manifest=candidate,
            )
            return report
        finally:
            # 5. 清理临时注册
            registry.remove(temp_id)

    @classmethod
    def compare(
        cls,
        original_report: EvaluationReport,
        candidate_report: EvaluationReport | None,
    ) -> dict:
        """对比原技能与候选技能的报告。

        Returns:
            {
                "improvement": float,  # delta overall_score (>0 = better, <0 = worse)
                "promotable": bool,     # candidate is better than original by margin
                "detail": str
            }
        """
        if candidate_report is None:
            return {"improvement": -1.0, "promotable": False, "detail": "候选执行失败"}

        delta = round(candidate_report.overall_score - original_report.overall_score, 4)
        promotable = delta >= 0.05  # 至少 5% 改善才提升

        return {
            "improvement": delta,
            "promotable": promotable,
            "detail": (
                f"候选({candidate_report.overall_score:.2f}) vs 原({original_report.overall_score:.2f}), "
                f"Δ={delta:+.4f}, {'可提升' if promotable else '不提升'}"
            ),
        }
