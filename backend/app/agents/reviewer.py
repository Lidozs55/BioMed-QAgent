"""Reviewer Agent — LLM 质量审查 + 追查任务提取。

职责：
- 准备审查摘要（数据源分布 + 前10条记录样本）
- 调用 LLM（qwen-max）审查数据质量与完整性
- 返回 quality/completeness/issues/recommendations/key_findings
- 追查任务提取：基于报告薄弱点 + query_log（已失败查询），LLM 生成
  followup_tasks，驱动方案 A 隐性循环（Orchestrator 追查循环）
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
    description = "LLM 驱动的数据质量审查 + 追查任务提取"

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

        # 追查任务提取：基于审查薄弱点 + query_log，生成下一轮追查任务
        followup_tasks = await self._extract_followup_tasks(
            task, records, context, review, progress)

        self._set_stage(task, "review", StageStatus.DONE, msg,
                        records_count=len(records))
        self._emit(progress, type="stage_complete", stage="review",
                    message=msg, review=review,
                    followup_tasks=followup_tasks)
        self.store.update_task(task)
        context["review"] = review
        context["followup_tasks"] = followup_tasks
        return records, context

    # ========== 追查任务提取（方案 A 隐性循环驱动） ==========

    async def _extract_followup_tasks(self, task: Task, records: list[dict],
                                       context: dict, review: dict,
                                       progress: ProgressCallback | None
                                       ) -> list[dict]:
        """从审查薄弱点 + query_log 生成追查任务。

        追查任务结构：
            {{"query": "MMP9 pancreatic cancer mechanism",
              "target_entities": {{"genes": ["MMP9"], "compounds": []}},
              "reason": "PPI 网络显示 MMP9 是 Hub 但报告缺乏其机制数据"}}

        收敛保障：
        - 已失败的查询（query_log 中 status=not_found）不再生成相同追查
        - LLM 判断无需追查时返回空列表
        """
        if not self.llm.is_available():
            return []

        # 压缩 query_log：只保留 query + status，避免 context 爆炸
        query_log = context.get("query_log", [])
        failed_queries = {entry.get("query", "") for entry in query_log
                          if entry.get("status") == "not_found"}
        query_log_summary = json.dumps([
            {"query": e.get("query", ""), "status": e.get("status", ""),
             "count": e.get("records_count", 0)}
            for e in query_log[-20:]  # 最近 20 条
        ], ensure_ascii=False)

        analysis = context.get("analysis", {}) or {}
        analysis_keys = list(analysis.keys()) if analysis else []

        prompt = f"""你是生物医学研究的数据完整性审查专家。

研究目标：{task.research_goal}
已识别实体：{json.dumps(context.get('entities', {}), ensure_ascii=False)}
分析结果：{analysis_keys}
审查结论：质量={review.get('overall_quality', 'unknown')}, 完整度={review.get('completeness_score', 0)}
缺失数据：{review.get('missing_data', [])}
审查建议：{review.get('recommendations', [])}

已执行查询日志（压缩）：
{query_log_summary}

请基于报告薄弱点判断是否需要追查。追查应针对：
- 报告中缺失的关键数据（如某 Hub 基因的机制、某化合物的靶点）
- 分析结果中的空白（如 PPI 网络有但缺乏富集分析）
- 已失败查询不要重复（见日志中 status=not_found 的查询）

返回严格 JSON：
{{
  "followup_tasks": [
    {{
      "query": "针对薄弱点的精准检索词",
      "target_entities": {{"genes": ["基因名"], "compounds": ["化合物名"]}},
      "reason": "为什么需要追查这个",
      "priority": "high|medium|low"
    }}
  ]
}}

判断原则：
- 若报告已充分覆盖研究目标，返回空 followup_tasks
- 追查查询应精准（如 "MMP9 pancreatic cancer liver metastasis mechanism"），避免宽泛
- 最多 3 个追查任务，避免冗余
- 已失败查询不要重复生成"""

        try:
            result = await self._to_thread(
                self.llm.chat_json,
                [{"role": "user", "content": prompt}],
                model=MODEL_STRONG,
                temperature=0.3,
            )
            tasks = result.get("followup_tasks", []) or []
            # 过滤已失败查询
            filtered = [t for t in tasks
                        if t.get("query", "") not in failed_queries]
            if len(filtered) < len(tasks):
                logger.info("追查任务过滤：%d → %d（排除已失败查询）",
                            len(tasks), len(filtered))
            logger.info("提取 %d 个追查任务", len(filtered))
            return filtered[:3]  # 硬性上限 3 个
        except Exception as e:
            logger.warning("追查任务提取失败: %s", e)
            return []
