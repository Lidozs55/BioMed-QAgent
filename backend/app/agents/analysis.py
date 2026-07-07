"""Analysis Agent — 生物信息学分析。

从 Orchestrator._stage_analyze 迁入，并增强为按数据类型路由调用
新接入的分析工具（差异表达/Hub 基因/上游调控/生存分析）。

分析路由策略：
- 有基因列表 → PPI 网络 / 富集 / Hub 基因 / 上游调控
- 有化合物 → 药物-靶点
- 有表达矩阵（log2fc/p_value）→ 差异表达
- 有 TCGA 队列 + 基因 → 生存分析（可选）
"""
from __future__ import annotations

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

        # Step 1: STRING PPI 网络分析（如有基因列表）
        if gene_list:
            self._emit(progress, type="stage_progress", stage="analyze",
                        pct=0.2,
                        message=f"PPI 网络分析（{len(gene_list)} 个基因）...")
            ppi_out = out_dir / "ppi_result.json"
            result = await self._to_thread(
                self.tools.run_ppi, gene_list[:20], task.task_id, ppi_out,
            )
            if result.success and result.data:
                analysis["ppi_network"] = (result.data
                                            if isinstance(result.data, dict)
                                            else {"edges": result.data})
                self._emit(progress, type="stage_progress", stage="analyze",
                            pct=0.3, message="PPI 网络分析完成")
            else:
                self._emit(progress, type="stage_progress", stage="analyze",
                            pct=0.3,
                            message=f"PPI 跳过: {result.error[:40]}")

        # Step 2: GO/KEGG 富集分析
        if gene_list:
            self._emit(progress, type="stage_progress", stage="analyze",
                        pct=0.4, message="GO/KEGG 富集分析...")
            enr_out = out_dir / "enrichment_result.json"
            result = await self._to_thread(
                self.tools.run_enrichment, gene_list[:50], task.task_id, enr_out,
            )
            if result.success and result.data:
                analysis["enrichment"] = (result.data
                                            if isinstance(result.data, dict)
                                            else {"terms": result.data})
                self._emit(progress, type="stage_progress", stage="analyze",
                            pct=0.5, message="富集分析完成")
            else:
                self._emit(progress, type="stage_progress", stage="analyze",
                            pct=0.5,
                            message=f"富集跳过: {result.error[:40]}")

        # Step 3: 药物-靶点分析（如有化合物）
        if compounds:
            self._emit(progress, type="stage_progress", stage="analyze",
                        pct=0.6, message="药物-靶点分析...")
            dt_out = out_dir / "drug_target_result.json"
            result = await self._to_thread(
                self.tools.run_drug_target, compounds[:5], task.task_id, dt_out,
            )
            if result.success and result.data:
                analysis["drug_targets"] = (result.data
                                             if isinstance(result.data, dict)
                                             else {"compounds": result.data})
                self._emit(progress, type="stage_progress", stage="analyze",
                            pct=0.65, message="药物-靶点分析完成")

        # Step 4: 差异表达分析（如有表达数据）
        if has_expr and records:
            self._emit(progress, type="stage_progress", stage="analyze",
                        pct=0.72, message="差异表达分析...")
            de_out = out_dir / "diff_expr_result.json"
            result = await self._to_thread(
                self.tools.run_diff_expression, records, task.task_id,
                output_file=de_out,
            )
            if result.success and result.data:
                analysis["diff_expression"] = result.data
                self._emit(progress, type="stage_progress", stage="analyze",
                            pct=0.78, message="差异表达分析完成")
            else:
                self._emit(progress, type="stage_progress", stage="analyze",
                            pct=0.78,
                            message=f"差异表达跳过: {result.error[:40]}")

        # Step 5: Hub 基因识别（基于 PPI 结果，如有基因列表）
        if gene_list:
            self._emit(progress, type="stage_progress", stage="analyze",
                        pct=0.84, message="Hub 基因识别...")
            hub_out = out_dir / "hub_gene_result.json"
            result = await self._to_thread(
                self.tools.run_hub_gene, gene_list[:20], task.task_id,
                output_file=hub_out,
            )
            if result.success and result.data:
                analysis["hub_gene"] = result.data
                self._emit(progress, type="stage_progress", stage="analyze",
                            pct=0.88, message="Hub 基因识别完成")
            else:
                self._emit(progress, type="stage_progress", stage="analyze",
                            pct=0.88,
                            message=f"Hub 基因跳过: {result.error[:40]}")

        # Step 6: 上游调控因子分析（如有基因列表）
        if gene_list:
            self._emit(progress, type="stage_progress", stage="analyze",
                        pct=0.92, message="上游调控因子分析...")
            ur_out = out_dir / "upstream_regulator_result.json"
            result = await self._to_thread(
                self.tools.run_upstream_regulator, gene_list[:20], task.task_id,
                output_file=ur_out,
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
