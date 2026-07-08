"""Analysis Agent — 生物信息学分析。

从 Orchestrator._stage_analyze 迁入，并增强为按数据类型路由调用
新接入的分析工具（差异表达/Hub 基因/上游调控/生存分析）。

分析路由策略：
- 有基因列表 → PPI 网络 / 富集 / Hub 基因 / 上游调控
- 有化合物 → 药物-靶点
- 有表达矩阵（log2fc/p_value）→ 差异表达
- 有 TCGA 队列 + 基因 → 生存分析（可选）

性能优化（消除分析阶段卡顿）：
- Step 1/2/3/4（PPI/富集/药物靶点/差异表达）无依赖，并行执行
- Step 5/6（Hub 基因/上游调控）复用 Step 1 的 PPI 结果，不重复调用 STRING API
  （原实现 Step 6 对 20 个基因串行调用 STRING 20 次，是主要卡顿来源）
"""
from __future__ import annotations

import asyncio
import logging

from app.agents.base import BaseAgent, ProgressCallback
from app.agents.registry import AgentRegistry
from app.models.task import Task, StageStatus
from app.utils.paths import get_task_output_dir

logger = logging.getLogger(__name__)


@AgentRegistry.register
class AnalysisAgent(BaseAgent):
    name = "analyze"
    description = "PPI/富集/药物靶点/差异表达/Hub基因/生存分析"

    async def execute(self, task: Task, records: list[dict],
                      context: dict,
                      progress: ProgressCallback | None = None) -> tuple[list[dict], dict]:
        self._set_stage(task, "analyze", StageStatus.RUNNING, "生物信息学分析中...")
        self._emit(progress, type="stage_start", stage="analyze",
                    message="根据数据类型运行链式分析...")

        analysis: dict = {}
        out_dir = get_task_output_dir(task.task_id)

        entities = context.get("entities", {})
        gene_list = entities.get("genes", [])
        compounds = entities.get("compounds", [])

        # 检测数据类型
        has_expr = any(
            "expression" in str(r.get("fields", {})).lower()
            or "log2fc" in str(r.get("fields", {})).lower()
            for r in records
        )

        # ===== Phase 1: 无依赖分析并行执行 =====
        # PPI / 富集 / 药物靶点 / 差异表达 之间无依赖，可并行
        self._emit(progress, type="stage_progress", stage="analyze",
                    pct=0.1, message="并行执行 PPI/富集/药物靶点/差异表达...")

        coros: list[asyncio.Task] = []
        labels: list[str] = []

        if gene_list:
            coros.append(self._run_ppi(gene_list, task, out_dir, progress))
            labels.append("ppi_network")
            coros.append(self._run_enrichment(gene_list, task, out_dir, progress))
            labels.append("enrichment")

        if compounds:
            coros.append(self._run_drug_target(compounds, gene_list, task, out_dir, progress))
            labels.append("drug_targets")

        if has_expr and records:
            coros.append(self._run_diff_expr(records, task, out_dir, progress))
            labels.append("diff_expression")

        # 并行执行所有无依赖分析
        if coros:
            results = await asyncio.gather(*coros, return_exceptions=True)
            for label, res in zip(labels, results):
                if isinstance(res, Exception):
                    logger.warning("分析 %s 异常: %s", label, res)
                    task.errors.append(f"{label}: {res}")
                elif res:
                    analysis[label] = res

        # ===== Phase 2: 依赖 PPI 结果的分析 =====
        # Hub 基因 / 上游调控 复用 PPI 结果，不重复调用 STRING
        ppi_result = analysis.get("ppi_network", {})
        ppi_edges = (ppi_result.get("chart_data", {}) or {}).get("edges", []) \
            if isinstance(ppi_result, dict) else []

        if gene_list:
            # Hub 基因识别（复用 PPI 结果）
            self._emit(progress, type="stage_progress", stage="analyze",
                        pct=0.8, message="Hub 基因识别（复用 PPI 结果）...")
            hub_out = out_dir / "hub_gene_result.json"
            result = await self._to_thread(
                self.tools.run_hub_gene, gene_list[:20], task.task_id,
                output_file=hub_out, ppi_result=ppi_result or None,
            )
            if result.success and result.data:
                analysis["hub_gene"] = result.data
                self._emit(progress, type="stage_progress", stage="analyze",
                            pct=0.88, message="Hub 基因识别完成")
            else:
                self._emit(progress, type="stage_progress", stage="analyze",
                            pct=0.88,
                            message=f"Hub 基因跳过: {result.error[:40]}")

            # 上游调控因子（复用 PPI 边数据）
            self._emit(progress, type="stage_progress", stage="analyze",
                        pct=0.9, message="上游调控因子分析（复用 PPI 结果）...")
            ur_out = out_dir / "upstream_regulator_result.json"
            result = await self._to_thread(
                self.tools.run_upstream_regulator, gene_list[:20], task.task_id,
                output_file=ur_out,
                ppi_edges=ppi_edges or None,
            )
            if result.success and result.data:
                analysis["upstream_regulator"] = result.data
                self._emit(progress, type="stage_progress", stage="analyze",
                            pct=0.95, message="上游调控因子分析完成")
            else:
                self._emit(progress, type="stage_progress", stage="analyze",
                            pct=0.95,
                            message=f"上游调控跳过: {result.error[:40]}")

        msg = f"分析完成：{len(analysis)} 项分析结果"
        self._set_stage(task, "analyze", StageStatus.DONE, msg)
        self._emit(progress, type="stage_complete", stage="analyze",
                    message=msg, analysis=analysis)
        self.store.set_analysis(task.task_id, analysis)

        # 记录溯源：分析阶段
        prov = self.store.get_provenance(task.task_id)
        if prov and analysis:
            prov.record("analyze", "analysis_agent",
                       tool_name=",".join(analysis.keys()),
                       output_records=[],
                       parameters={"analysis_types": list(analysis.keys()),
                                   "gene_count": len(gene_list),
                                   "compound_count": len(compounds)})
        self.store.update_task(task)
        context["analysis"] = analysis
        return records, context

    # ===== 各分析的独立方法（供并行调用） =====

    async def _run_ppi(self, gene_list: list[str], task: Task,
                       out_dir, progress: ProgressCallback | None) -> dict | None:
        """PPI 网络分析。"""
        self._emit(progress, type="stage_progress", stage="analyze",
                    pct=0.15, message=f"PPI 网络分析（{len(gene_list)} 个基因）...")
        ppi_out = out_dir / "ppi_result.json"
        result = await self._to_thread(
            self.tools.run_ppi, gene_list[:20], task.task_id, ppi_out,
        )
        if result.success and result.data:
            self._emit(progress, type="stage_progress", stage="analyze",
                        pct=0.3, message="PPI 网络分析完成")
            return (result.data if isinstance(result.data, dict)
                    else {"edges": result.data})
        self._emit(progress, type="stage_progress", stage="analyze",
                    pct=0.3, message=f"PPI 跳过: {result.error[:40]}")
        return None

    async def _run_enrichment(self, gene_list: list[str], task: Task,
                               out_dir, progress: ProgressCallback | None) -> dict | None:
        """GO/KEGG 富集分析。"""
        self._emit(progress, type="stage_progress", stage="analyze",
                    pct=0.2, message="GO/KEGG 富集分析...")
        enr_out = out_dir / "enrichment_result.json"
        result = await self._to_thread(
            self.tools.run_enrichment, gene_list[:50], task.task_id, enr_out,
        )
        if result.success and result.data:
            self._emit(progress, type="stage_progress", stage="analyze",
                        pct=0.5, message="富集分析完成")
            return (result.data if isinstance(result.data, dict)
                    else {"terms": result.data})
        self._emit(progress, type="stage_progress", stage="analyze",
                    pct=0.5, message=f"富集跳过: {result.error[:40]}")
        return None

    async def _run_drug_target(self, compounds: list[str],
                                gene_list: list[str], task: Task,
                                out_dir, progress: ProgressCallback | None) -> dict | None:
        """药物-靶点分析。"""
        self._emit(progress, type="stage_progress", stage="analyze",
                    pct=0.25, message="药物-靶点分析...")
        dt_out = out_dir / "drug_target_result.json"
        result = await self._to_thread(
            self.tools.run_drug_target, compounds[:5], task.task_id, dt_out,
            genes=gene_list[:10] or None,
        )
        if result.success and result.data:
            self._emit(progress, type="stage_progress", stage="analyze",
                        pct=0.65, message="药物-靶点分析完成")
            return (result.data if isinstance(result.data, dict)
                    else {"compounds": result.data})
        return None

    async def _run_diff_expr(self, records: list[dict], task: Task,
                              out_dir, progress: ProgressCallback | None) -> dict | None:
        """差异表达分析。"""
        self._emit(progress, type="stage_progress", stage="analyze",
                    pct=0.3, message="差异表达分析...")
        de_out = out_dir / "diff_expr_result.json"
        result = await self._to_thread(
            self.tools.run_diff_expression, records, task.task_id,
            output_file=de_out,
        )
        if result.success and result.data:
            self._emit(progress, type="stage_progress", stage="analyze",
                        pct=0.7, message="差异表达分析完成")
            return result.data
        self._emit(progress, type="stage_progress", stage="analyze",
                    pct=0.7, message=f"差异表达跳过: {result.error[:40]}")
        return None
