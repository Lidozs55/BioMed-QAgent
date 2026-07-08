"""技能修复模块 — 对低质量技能进行自动修复。

SkillRepairAgent 分析 EvaluationReport，利用 LLM 改进 SkillManifest：
- 优化 description（更精准描述功能）
- 扩充 tags（添加相关同义词）
- 调整 inputs/outputs（更准确的输入输出字段）
- 增量提升 version

修复后的 SkillManifest 作为 'candidate' 版本暂存，
由 CandidateRunner 测试后再由 PromotionManager 决定是否提升。
"""
from __future__ import annotations

import logging
from typing import Any

from app.skills.manifest import SkillManifest, SkillInputField, SkillOutputField
from app.skills.evaluator import EvaluationReport

logger = logging.getLogger(__name__)

REPAIR_THRESHOLD = 0.5  # overall_score below this triggers repair


class SkillRepairAgent:
    """修复低质量技能的 Agent。

    支持两种修复策略：
    1. 规则修复：基于 EvaluationReport 的 missing 信息直接补齐
    2. LLM 修复：调用 LLM 语义优化 description 和 tags
    """

    @classmethod
    def needs_repair(cls, report: EvaluationReport) -> bool:
        """判断技能是否需要修复（overall_score < 阈值）。"""
        return report.overall_score < REPAIR_THRESHOLD

    @classmethod
    def repair(
        cls,
        manifest: SkillManifest,
        report: EvaluationReport,
        execution_result: Any = None,
        llm=None,  # optional LLM client for semantic repair
    ) -> SkillManifest | None:
        """尝试修复一个技能，返回修复后的候选 manifest 或 None。

        Args:
            manifest: 原技能清单
            report: 技能执行评估报告
            execution_result: 技能执行原始结果（用于上下文）
            llm: LLM 客户端（可选，用于语义级修复）

        Returns:
            修复后的 SkillManifest（候选版本），或 None（无法修复）
        """
        changes: list[str] = []

        # 1. 规则修复：补齐 missing 字段
        new_inputs = cls._repair_inputs(manifest, report, changes)
        new_outputs = cls._repair_outputs(manifest, report, changes)

        # 2. 语义修复：用 LLM 优化 description 和 tags
        new_description = manifest.description
        new_tags = list(manifest.tags)

        if llm is not None:
            try:
                sem_fix = cls._llm_repair(manifest, report, llm, execution_result)
                if sem_fix.get("description"):
                    new_description = sem_fix["description"]
                    changes.append("description 由 LLM 优化")
                if sem_fix.get("tags"):
                    new_tags = list(set(manifest.tags) | set(sem_fix["tags"]))
                    changes.append(f"tags 扩充: +{len(sem_fix['tags'])} 标签")
            except Exception as e:
                logger.warning("LLM 修复失败: %s，使用规则修复", e)

        if not changes:
            logger.info("技能 %s 无需修复", manifest.skill_id)
            return None

        # 3. 构造候选版本（版本号递增）
        old_ver = manifest.version or "1.0.0"
        new_version = cls._bump_version(old_ver)

        return SkillManifest(
            skill_id=manifest.skill_id,
            name=manifest.name,
            description=new_description,
            category=manifest.category,
            version=new_version,
            tags=new_tags,
            inputs=new_inputs,
            outputs=new_outputs,
            quality_indicators=manifest.quality_indicators,
        )

    # ── 规则修复 ──────────────────────────────────────────────

    @classmethod
    def _repair_inputs(
        cls, manifest: SkillManifest, report: EvaluationReport, changes: list[str]
    ) -> list[SkillInputField]:
        """补齐缺失的必填输入字段到 optional。"""
        if not report.missing_inputs:
            return list(manifest.inputs)

        new = list(manifest.inputs)
        for field_name in report.missing_inputs:
            # 添加为 optional 字段
            new.append(SkillInputField(name=field_name, type="string", required=False, default=None))
            changes.append(f"inputs 补齐: +{field_name} (optional)")

        return new

    @classmethod
    def _repair_outputs(
        cls, manifest: SkillManifest, report: EvaluationReport, changes: list[str]
    ) -> list[SkillOutputField]:
        """补齐缺失的期望输出字段。"""
        if not report.missing_outputs:
            return list(manifest.outputs)

        new = list(manifest.outputs)
        for field_name in report.missing_outputs:
            new.append(SkillOutputField(name=field_name, type="any"))
            changes.append(f"outputs 补齐: +{field_name}")

        return new

    # ── LLM 修复 ──────────────────────────────────────────────

    @staticmethod
    def _llm_repair(
        manifest: SkillManifest, report: EvaluationReport, llm, execution_result: Any
    ) -> dict:
        """调用 LLM 优化 description 和扩充 tags。"""
        prompt = f"""你是技能定义优化专家。以下技能执行后评分较低，请优化其描述和标签。

技能 ID: {manifest.skill_id}
技能名: {manifest.name}
当前描述: {manifest.description}
当前分类: {manifest.category}
当前标签: {', '.join(manifest.tags)}

评估结果:
- 覆盖度: {report.coverage_score}
- 完整度: {report.completeness_score}
- 冲突度: {report.conflict_score}
- 综合: {report.overall_score}
- 缺失输入: {report.missing_inputs}
- 缺失输出: {report.missing_outputs}

请返回 JSON:
{{
  "description": "优化后的技能描述（50 字内、更精准描述功能边界和数据要求）",
  "tags": ["tag1", "tag2", "tag3"]  // 5-10 个补充标签，用于提高检索命中率
}}
"""
        result = llm.chat_json([{"role": "user", "content": prompt}], temperature=0.3)
        if isinstance(result, dict):
            return result
        return {}

    # ── 版本号 ────────────────────────────────────────────────

    @staticmethod
    def _bump_version(version: str) -> str:
        """递增补丁版本号。

        Handles semantic versions ("1.0.0" → "1.0.1") as well as
        legacy "active"/"dormant" strings (treated as "1.0.0" base).
        """
        # Handle legacy non-semver versions
        if not version or version in ("active", "dormant"):
            return "1.0.1"

        try:
            parts = version.split(".")
            if len(parts) == 3:
                parts[2] = str(int(parts[2]) + 1)
                return ".".join(parts)
        except (ValueError, IndexError):
            pass
        return "2.0.0" if version != "2.0.0" else "2.0.1"
