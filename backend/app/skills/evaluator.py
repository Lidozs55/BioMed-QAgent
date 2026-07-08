"""技能质量评估 — 执行后对技能结果进行覆盖度、完整度、冲突度评分。

用法：
    from app.skills.evaluator import EvaluationReport, SkillEvaluator

    report = SkillEvaluator.evaluate(
        skill_id="pubmed",
        result=result_data,
        expected_outputs=["records", "total_count"],
        provided_inputs={"query": "cancer", "max_results": 50},
        manifest=manifest,
    )
"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, computed_field

from app.skills.manifest import SkillManifest


class EvaluationReport(BaseModel):
    """Post-execution quality evaluation of a skill result."""

    skill_id: str = Field(
        ...,
        description="被评估的技能 ID",
    )
    coverage_score: float = Field(
        0.0,
        ge=0.0,
        le=1.0,
        description="输入覆盖度（必填输入满足比例）",
    )
    completeness_score: float = Field(
        0.0,
        ge=0.0,
        le=1.0,
        description="输出完整度（期望输出满足比例）",
    )
    conflict_score: float = Field(
        0.0,
        ge=0.0,
        le=1.0,
        description="冲突度（无冲突为 1.0，冲突越多越低）",
    )
    @computed_field
    @property
    def overall_score(self) -> float:
        """综合评分：0.3*cov + 0.3*com + 0.4*con，自动计算。"""
        return round(
            0.3 * self.coverage_score
            + 0.3 * self.completeness_score
            + 0.4 * self.conflict_score,
            4,
        )
    missing_inputs: list[str] = Field(
        default_factory=list,
        description="缺失的必填输入字段名",
    )
    missing_outputs: list[str] = Field(
        default_factory=list,
        description="缺失的期望输出字段名",
    )
    conflicts: list[str] = Field(
        default_factory=list,
        description="检测到的数据冲突（如重复 record_id）",
    )
    notes: str = Field(
        "",
        description="评估备注",
    )


class SkillEvaluator:
    """Evaluates skill results on coverage, completeness, conflict.

    所有方法均使用 classmethod 接口，与 SkillRegistry 风格一致。
    """

    # ── 主入口 ──────────────────────────────────────────────────

    @classmethod
    def evaluate(
        cls,
        skill_id: str,
        result: Any,
        expected_outputs: list[Any] | None = None,
        provided_inputs: dict[str, Any] | None = None,
        manifest: SkillManifest | None = None,
    ) -> EvaluationReport:
        """Main entry point. Computes all three scores and returns EvaluationReport.

        Args:
            skill_id: 被评估的技能 ID
            result: 技能执行结果（SkillResult 对象或 dict）
            expected_outputs: 期望的输出字段列表（str 或 SkillOutputField）
            provided_inputs: 实际提供的输入（字段名 → 值）
            manifest: 技能清单（含 required inputs 定义）

        Returns:
            EvaluationReport 含所有三项评分及 details
        """
        # 提取 result_data：兼容 SkillResult 和 dict
        result_data = result.data if hasattr(result, "data") else result

        coverage, missing_inputs = cls._compute_coverage(
            manifest, provided_inputs or {}
        )
        completeness, missing_outputs = cls._compute_completeness(
            result_data, expected_outputs
        )
        conflict, conflicts = cls._detect_conflicts(result_data)

        return EvaluationReport(
            skill_id=skill_id,
            coverage_score=coverage,
            completeness_score=completeness,
            conflict_score=conflict,
            missing_inputs=missing_inputs,
            missing_outputs=missing_outputs,
            conflicts=conflicts,
        )

    # ── 覆盖度 ──────────────────────────────────────────────────

    @classmethod
    def _compute_coverage(
        cls,
        manifest: SkillManifest | None,
        provided_inputs: dict[str, Any],
    ) -> tuple[float, list[str]]:
        """检查 manifest 中的必填输入是否都在 provided_inputs 中。

        Args:
            manifest: 技能清单（None 表示无输入约束，得分 1.0）
            provided_inputs: 实际传入的输入键值对

        Returns:
            (score, missing_inputs_list)
        """
        if manifest is None:
            return (1.0, [])

        required = [f for f in manifest.inputs if f.required]
        if not required:
            return (1.0, [])

        missing = [f.name for f in required if f.name not in provided_inputs]
        score = round(1.0 - len(missing) / len(required), 4)
        return (score, missing)

    # ── 完整度 ──────────────────────────────────────────────────

    @classmethod
    def _compute_completeness(
        cls,
        result_data: Any,
        expected_outputs: list[Any] | None,
    ) -> tuple[float, list[str]]:
        """检查期望输出字段是否出现在结果数据中。

        兼容 SkillResult.data、dict 和普通对象。

        Args:
            result_data: 结果数据（dict / 对象 / 列表）
            expected_outputs: 期望字段名列表（str）或 SkillOutputField 列表；
                              None 表示无输出约束，得分 1.0

        Returns:
            (score, missing_outputs_list)
        """
        if expected_outputs is None:
            return (1.0, [])

        # 归一化期望字段名为 str 列表
        expected: list[str] = []
        for item in expected_outputs:
            if isinstance(item, str):
                expected.append(item)
            elif hasattr(item, "name"):
                expected.append(item.name)

        if not expected:
            return (1.0, [])

        # 从 result_data 收集可用字段名
        available: set[str] = set()
        if isinstance(result_data, dict):
            available = set(result_data.keys())
        elif hasattr(result_data, "__dict__"):
            available = set(result_data.__dict__.keys())

        missing = [name for name in expected if name not in available]
        score = round(1.0 - len(missing) / len(expected), 4)
        return (score, missing)

    # ── 冲突检测 ────────────────────────────────────────────────

    @classmethod
    def _detect_conflicts(
        cls,
        result_data: Any,
    ) -> tuple[float, list[str]]:
        """检测列表结果中的重复 record_id 冲突。

        Args:
            result_data: 结果数据（仅列表类型会检查）

        Returns:
            (score, conflicts_list) — 无冲突时 score=1.0
        """
        if not isinstance(result_data, list) or not result_data:
            return (1.0, [])

        # 收集所有 record_id
        record_ids: list[str] = []
        for item in result_data:
            if isinstance(item, dict):
                rid = item.get("record_id")
            else:
                rid = getattr(item, "record_id", None)
            if rid is not None:
                record_ids.append(str(rid))

        if len(record_ids) < 2:
            return (1.0, [])

        unique = set(record_ids)
        if len(unique) == len(record_ids):
            return (1.0, [])

        # 找出重复的 rid
        seen: set[str] = set()
        dupes: set[str] = set()
        for rid in record_ids:
            if rid in seen:
                dupes.add(rid)
            else:
                seen.add(rid)

        score = round(len(unique) / len(record_ids), 4)
        conflicts_list = [f"Duplicate record_id: {d}" for d in sorted(dupes)]
        return (score, conflicts_list)
