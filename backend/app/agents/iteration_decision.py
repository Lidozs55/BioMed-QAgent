"""Iteration Decision Agent — 多轮检索迭代收敛判断。

职责（对齐 docs/multi_round_search_iteration.md §3.2）：
- 每轮 review 后，基于 LLM 决定是否继续迭代
- 计算"规划实体 vs 已验证实体"的 gap
- 结合新增记录趋势判断收敛
- 输出下一轮的精准查询与目标实体

收敛条件（任一满足即终止，对齐 §3.3）：
1. 新增记录数 < 阈值（默认 5）—— 检索饱和
2. 规划实体全部验证 —— 无 gap
3. LLM 判断无 gap
4. 达到最大轮数（默认 3）
5. 新增记录重复率 > 80%
"""
from __future__ import annotations

import logging

from app.agents.base import BaseAgent, ProgressCallback
from app.agents.registry import AgentRegistry
from app.config import MODEL_STRONG
from app.models.task import Task

logger = logging.getLogger(__name__)

# 收敛阈值（对齐文档 §3.3）
_MIN_NEW_RECORDS = 5      # 新增记录数低于此值视为饱和
_MAX_DUP_RATE = 0.8       # 重复率高于此值视为收敛


@AgentRegistry.register
class IterationDecisionAgent(BaseAgent):
    name = "iteration_decision"
    description = "多轮迭代收敛判断（LLM 驱动 gap 分析）"

    async def execute(self, task: Task, records: list[dict],
                      context: dict,
                      progress: ProgressCallback | None = None) -> tuple[list[dict], dict]:
        round_idx = context.get("round_idx", 1)
        max_rounds = context.get("max_rounds", 3)
        round_new_counts: list[int] = context.get("round_new_counts", [])

        self._emit(progress, type="stage_progress", stage="iteration",
                    message=f"迭代决策（第 {round_idx} 轮）...")

        # 1. 计算 gap：规划实体 vs 已验证实体
        planned = context.get("entities", {})
        verified = self._compute_verified_entities(records, context)
        gap = self._compute_gap(planned, verified)

        # 2. 规则级收敛判断（无需 LLM，硬性终止）
        decision = self._rule_based_convergence(
            round_idx, max_rounds, round_new_counts, gap, records, context)
        if decision is not None:
            context["iteration_decision"] = decision
            self._emit(progress, type="iteration_decision",
                        round=round_idx, **decision)
            logger.info("迭代收敛（规则）第 %d 轮: %s",
                        round_idx, decision.get("reason"))
            return records, context

        # 3. LLM 驱动决策（规则未终止时，让 LLM 判断 gap 是否值得继续）
        decision = await self._llm_decide(
            task, records, context, gap, verified, round_idx,
            round_new_counts, progress)
        context["iteration_decision"] = decision
        self._emit(progress, type="iteration_decision",
                    round=round_idx, **decision)
        return records, context

    # ========== 已验证实体计算 ==========

    @staticmethod
    def _compute_verified_entities(records: list[dict],
                                    context: dict) -> dict[str, set[str]]:
        """从累积记录与分析结果中提取已验证实体。"""
        verified_genes: set[str] = set()
        verified_compounds: set[str] = set()

        # 从 records 的 fields 提取
        for r in records:
            fields = r.get("fields", {}) or {}
            for key in ("gene_symbol", "gene", "target", "target_gene"):
                val = fields.get(key)
                if val and isinstance(val, str):
                    verified_genes.add(val.upper())
            for key in ("compound_name", "compound", "drug_name"):
                val = fields.get(key)
                if val and isinstance(val, str):
                    verified_compounds.add(val)

        # 从分析结果提取（PPI 节点、药物靶点）
        analysis = context.get("analysis", {}) or {}
        ppi = analysis.get("ppi_network", {}) or {}
        chart = ppi.get("chart_data", {}) or {}
        for node in chart.get("nodes", []) or []:
            label = node.get("label") or node.get("id") or node.get("name")
            if label and isinstance(label, str):
                verified_genes.add(label.upper())

        dt = analysis.get("drug_targets", {}) or {}
        for item in dt.get("stats_table", []) or []:
            if isinstance(item, dict):
                comp = item.get("compound") or item.get("drug")
                if comp:
                    verified_compounds.add(str(comp))
                gene = item.get("target") or item.get("gene")
                if gene:
                    verified_genes.add(str(gene).upper())

        return {"genes": verified_genes, "compounds": verified_compounds}

    @staticmethod
    def _compute_gap(planned: dict, verified: dict[str, set[str]]) -> dict:
        """计算规划但未验证的实体（gap）。"""
        planned_genes = {g.upper() for g in planned.get("genes", [])}
        planned_compounds = {c for c in planned.get("compounds", [])}
        return {
            "genes": sorted(planned_genes - verified["genes"]),
            "compounds": sorted(planned_compounds - verified["compounds"]),
        }

    # ========== 规则级收敛判断 ==========

    @staticmethod
    def _rule_based_convergence(
            round_idx: int, max_rounds: int,
            round_new_counts: list[int], gap: dict,
            records: list[dict], context: dict) -> dict | None:
        """规则级收敛判断（无需 LLM）。返回 decision dict 或 None。"""
        # 条件 4: 达到最大轮数
        if round_idx >= max_rounds:
            return {"should_continue": False,
                    "reason": f"达到最大轮数({max_rounds})，终止迭代",
                    "next_round_queries": [], "target_entities": []}

        # 条件 1: 新增记录数 < 阈值（仅第 2 轮起判断，第 1 轮无前序对比）
        if round_idx > 1 and round_new_counts:
            new_count = round_new_counts[-1]
            if new_count < _MIN_NEW_RECORDS:
                return {"should_continue": False,
                        "reason": f"新增记录数({new_count})<{_MIN_NEW_RECORDS}，检索已饱和",
                        "next_round_queries": [], "target_entities": []}

        # 条件 2: 规划实体全部验证（无 gap）
        if not gap["genes"] and not gap["compounds"]:
            return {"should_continue": False,
                    "reason": "规划实体已全部在数据中验证，无 gap",
                    "next_round_queries": [], "target_entities": []}

        # 条件 5: 新增记录重复率 > 80%
        if round_idx > 1 and round_new_counts:
            # 重复率 = (本轮检索总数 - 新增数) / 本轮检索总数
            # 本轮检索总数近似为 records 长度减去之前累积
            total_so_far = len(records)
            prev_total = total_so_far - round_new_counts[-1]
            if prev_total > 0:
                round_total = total_so_far
                # 若本轮几乎无新增（重复率高）
                if round_new_counts[-1] / max(round_total, 1) < (1 - _MAX_DUP_RATE):
                    return {"should_continue": False,
                            "reason": f"新增记录重复率>{_MAX_DUP_RATE:.0%}，检索收敛",
                            "next_round_queries": [], "target_entities": []}

        return None  # 规则未终止，需 LLM 决策

    # ========== LLM 驱动决策 ==========

    async def _llm_decide(self, task: Task, records: list[dict],
                          context: dict, gap: dict, verified: dict,
                          round_idx: int, round_new_counts: list[int],
                          progress: ProgressCallback | None) -> dict:
        """调用 LLM 判断是否继续迭代，并生成下一轮查询。"""
        if not self.llm.is_available():
            # 无 LLM 时：有 gap 就继续，否则终止
            should = bool(gap["genes"] or gap["compounds"])
            return {
                "should_continue": should,
                "reason": "无 LLM，按 gap 判断" + ("（有未验证实体）" if should else "（无 gap）"),
                "next_round_queries": self._build_fallback_queries(gap, task),
                "target_entities": gap["genes"] + gap["compounds"],
            }

        review = context.get("review", {}) or {}
        entities = context.get("entities", {}) or {}
        trend = " → ".join(str(c) for c in round_new_counts) or "无"

        prompt = f"""你是生物医学数据检索的迭代决策专家。判断是否需要追加一轮检索。

研究目标：{task.research_goal}
当前轮次：第 {round_idx} 轮
累积记录数：{len(records)}
各轮新增记录趋势：{trend}

规划实体：
- 基因：{entities.get('genes', [])}
- 化合物：{entities.get('compounds', [])}

已验证实体：
- 基因：{sorted(verified['genes'])}
- 化合物：{sorted(verified['compounds'])}

未验证 gap：
- 基因：{gap['genes']}
- 化合物：{gap['compounds']}

审查建议：{review.get('recommendations', [])}
缺失数据：{review.get('missing_data', [])}

请判断是否值得继续检索，并给出下一轮的精准查询。返回严格 JSON：
{{
  "should_continue": true/false,
  "reason": "决策理由",
  "next_round_queries": ["针对未验证实体的精准查询1", "查询2"],
  "target_entities": ["MMP9", "STAT1"],
  "convergence_signals": ["收敛信号1"]
}}

判断原则：
- 若 gap 中的实体有明确的研究价值且可能通过文献检索验证，则继续
- 若 gap 实体过于宽泛或前几轮已充分覆盖，则终止
- 下一轮查询应针对 gap 实体 + 研究目标构造精准查询（如 "MMP9 pancreatic cancer mechanism"）
- 最多 5 个查询，避免冗余"""

        try:
            result = await self._to_thread(
                self.llm.chat_json,
                [{"role": "user", "content": prompt}],
                model=MODEL_STRONG,
                temperature=0.3,
            )
            return {
                "should_continue": bool(result.get("should_continue", False)),
                "reason": result.get("reason", ""),
                "next_round_queries": result.get("next_round_queries", []),
                "target_entities": result.get("target_entities", []),
                "convergence_signals": result.get("convergence_signals", []),
            }
        except Exception as e:
            logger.warning("LLM 迭代决策失败: %s", e)
            should = bool(gap["genes"] or gap["compounds"])
            return {
                "should_continue": should,
                "reason": f"LLM 决策失败({e})，按 gap 判断",
                "next_round_queries": self._build_fallback_queries(gap, task),
                "target_entities": gap["genes"] + gap["compounds"],
            }

    @staticmethod
    def _build_fallback_queries(gap: dict, task: Task) -> list[str]:
        """无 LLM 时，基于 gap 构造下一轮查询。"""
        queries: list[str] = []
        goal_short = task.research_goal[:20]
        for g in gap["genes"][:3]:
            queries.append(f"{g} {goal_short}")
        for c in gap["compounds"][:2]:
            queries.append(f"{c} {goal_short}")
        return queries
