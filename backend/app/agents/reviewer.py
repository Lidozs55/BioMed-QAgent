"""Reviewer Agent — LLM 质量审查。

从 Orchestrator._stage_review 迁入，职责：
- 准备审查摘要（数据源分布 + 前10条记录样本）
- 调用 LLM（qwen-max）审查数据质量与完整性
- 返回 quality/completeness/issues/recommendations/key_findings
"""
from __future__ import annotations

import json
import logging

from app.agents.base import BaseAgent, ProgressCallback
from app.agents.registry import AgentRegistry
from app.config import MODEL_STRONG
from app.models.task import Task, StageStatus

logger = logging.getLogger(__name__)


@AgentRegistry.register
class ReviewerAgent(BaseAgent):
    name = "review"
    description = "LLM 驱动的数据质量审查"

    async def execute(self, task: Task, records: list[dict],
                      context: dict,
                      progress: ProgressCallback | None = None) -> tuple[list[dict], dict]:
        self._set_stage(task, "review", StageStatus.RUNNING, "LLM 审查数据质量...")
        self._emit(progress, type="stage_start", stage="review",
                    message="DashScope LLM 正在审查数据质量与完整性...")

        review: dict = {}
        if self.llm.is_available() and records:
            sources = {}
            for r in records:
                src = r.get("source_ref", {}).get("source_name", "unknown")
                sources[src] = sources.get(src, 0) + 1

            sample = records[:10]
            sample_summary = json.dumps([
                {"fields_keys": list(r.get("fields", {}).keys())[:5],
                 "source": r.get("source_ref", {}).get("source_name", ""),
                 "confidence": r.get("extraction_confidence", 0),
                 "flags": r.get("quality_flags", [])}
                for r in sample
            ], ensure_ascii=False)

            prompt = f"""审查以下生物医学数据整合结果的质量：

研究目标：{task.research_goal}
领域：{task.domain}
识别实体：{json.dumps(context.get('entities', {}), ensure_ascii=False)}
数据源分布：{json.dumps(sources, ensure_ascii=False)}
总记录数：{len(records)}
前10条摘要：{sample_summary}

请返回严格 JSON：
{{
  "overall_quality": "high|medium|low",
  "completeness_score": 0.0-1.0,
  "source_coverage": "对数据源覆盖完备性的评价",
  "data_quality_issues": ["问题1", "问题2"],
  "missing_data": ["缺失的数据类型"],
  "recommendations": ["改进建议1"],
  "key_findings": ["关键发现1", "关键发现2"],
  "confidence_assessment": "置信度评估说明"
}}"""

            try:
                review = await self._to_thread(
                    self.llm.chat_json,
                    [{"role": "user", "content": prompt}],
                    model=MODEL_STRONG,
                    temperature=0.3,
                )
                msg = (f"审查完成：质量={review.get('overall_quality', 'unknown')}, "
                       f"完整度={review.get('completeness_score', 0):.0%}")
            except Exception as e:
                logger.warning("LLM 审查失败: %s", e)
                review = {"error": str(e), "overall_quality": "unknown"}
                msg = f"LLM 审查失败: {e}"
        else:
            review = {"overall_quality": "unknown",
                      "note": "API Key 未配置或无数据"}
            msg = "跳过 LLM 审查（无 API Key 或无数据）"

        self._set_stage(task, "review", StageStatus.DONE, msg)
        self._emit(progress, type="stage_complete", stage="review",
                    message=msg, review=review)
        self.store.update_task(task)
        context["review"] = review
        return records, context
