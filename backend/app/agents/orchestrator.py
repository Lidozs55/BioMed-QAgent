"""Orchestrator — LLM 驱动的流水线编排器。

PIPELINE 调度模式（对齐 ARCHITECTURE.md 3.1.9）：
planning → [search → acquire → parse → clean → analyze → review] → export

设计：
- planning/export 由 Orchestrator 直接持有（输入解析 + 结果组装，非领域逻辑）
- search/acquire/parse/clean/analyze/review 委托给各阶段 Agent
  （通过 AgentRegistry 按 name 实例化，调用 execute(task, records, context, progress)）
- 每个 Agent 自管阶段状态、溯源、进度推送
- Darwinian Stage Gate 由 SearchAgent 内部实现（记录不足时扩展查询重试）

强制使用阿里云百炼 DashScope 平台。
"""
from __future__ import annotations

import asyncio
import csv
import json
import logging
import time
from pathlib import Path

from app.agents.base import ProgressCallback, BaseAgent
from app.agents.error_decision import ErrorDecisionAgent
from app.agents.registry import AgentRegistry, register_all_agents
from app.config import MODEL_TEXT
from app.llm.client import DashScopeClient
from app.models.task import Task, TaskStatus, StageStatus
from app.storage.task_store import TaskStore, get_task_store
from app.tools.registry import ToolRegistry, get_registry
from app.utils.paths import get_task_output_dir

logger = logging.getLogger(__name__)

# 流水线阶段顺序（planning/export 由 Orchestrator 直接处理，不在此列）
PIPELINE: tuple[str, ...] = (
    "search", "acquire", "parse", "clean", "analyze", "review",
)


class Orchestrator:
    """LLM 驱动的流水线编排器。

    通过 AgentRegistry 调度各阶段 Agent，自身只负责：
    - planning（LLM 实体识别）
    - export（CSV + LLM 研究报告）
    - 流水线编排与异常兜底
    - 多轮迭代调度（对齐 docs/multi_round_search_iteration.md）

    多轮迭代结构：
        planning → [Round N: search→acquire→parse→clean→analyze→review
                    → IterationDecisionAgent] → export
        迭代直到收敛或达到 MAX_ROUNDS
    """

    # 多轮迭代最大轮数（对齐文档 §3.3，防止无限循环）
    MAX_ROUNDS = 3

    def __init__(self, llm: DashScopeClient | None = None,
                 tools: ToolRegistry | None = None,
                 store: TaskStore | None = None):
        self.llm = llm or DashScopeClient()
        self.tools = tools or get_registry()
        self.store = store or get_task_store()
        # 注册所有阶段 Agent（触发 @AgentRegistry.register）
        register_all_agents()

    async def run(self, task: Task,
                  progress: ProgressCallback | None = None) -> Task:
        """执行完整流水线（多轮迭代）。"""
        try:
            task.status = TaskStatus.PLANNING
            self._emit(progress, type="task_start", task_id=task.task_id,
                        research_goal=task.research_goal)

            # Stage 1: Planning — Orchestrator 直接持有（LLM 提取实体）
            context = await self._stage_planning(task, progress)
            context["max_rounds"] = self.MAX_ROUNDS

            # Stage 2-7: 多轮迭代 PIPELINE — 每轮 search→...→review + 迭代决策
            all_records: list[dict] = []
            seen_ids: set[str] = set()
            round_new_counts: list[int] = []

            for round_idx in range(1, self.MAX_ROUNDS + 1):
                context["round_idx"] = round_idx
                context["round_new_counts"] = round_new_counts
                self._emit(progress, type="iteration_round",
                            round=round_idx, max_rounds=self.MAX_ROUNDS)

                # 执行一轮完整流水线
                round_records, context = await self._run_pipeline_round(
                    task, context, progress, round_idx)

                # 跨轮去重，累积到 all_records
                new_records = self._dedup_round(round_records, seen_ids)
                all_records.extend(new_records)
                round_new_counts.append(len(new_records))
                logger.info("第 %d 轮完成：新增 %d 条，累计 %d 条",
                            round_idx, len(new_records), len(all_records))

                # 最后一轮无需迭代决策
                if round_idx >= self.MAX_ROUNDS:
                    logger.info("达到最大轮数 %d，终止迭代", self.MAX_ROUNDS)
                    break

                # 迭代决策：是否继续
                decision_agent = self._get_agent("iteration_decision")
                if decision_agent is None:
                    logger.warning("IterationDecisionAgent 未注册，单轮执行")
                    break
                _, context = await decision_agent.execute(
                    task, all_records, context, progress)
                decision = context.get("iteration_decision", {})

                if not decision.get("should_continue", False):
                    logger.info("迭代收敛于第 %d 轮: %s",
                                round_idx, decision.get("reason", ""))
                    self._emit(progress, type="iteration_converged",
                                round=round_idx,
                                reason=decision.get("reason", ""))
                    break

                # 准备下一轮查询
                next_queries = decision.get("next_round_queries", [])
                if next_queries:
                    context["search_queries"] = next_queries
                logger.info("进入第 %d 轮：查询=%s",
                            round_idx + 1, next_queries[:3])

            # 人工确认点：审查后若质量低，暂停等待用户确认（TASK-014 人在回路）
            review = context.get("review", {})
            if self._needs_confirmation(task, all_records, review):
                payload = self._build_checkpoint_payload(task, all_records, review)
                task.status = TaskStatus.AWAITING_CONFIRMATION
                task.pending_checkpoint = "low_confidence"
                task.checkpoint_payload = payload
                self.store.set_records(task.task_id, all_records)
                self.store.save_task_to_file(task.task_id)
                self._emit(progress, type="awaiting_confirmation",
                            task_id=task.task_id,
                            checkpoint="low_confidence",
                            payload=payload)
                logger.info("任务 %s 暂停等待人工确认（低置信度/低质量）",
                            task.task_id)
                return task

            # Stage 8: Export — Orchestrator 直接持有（CSV + LLM 报告）
            await self._stage_export(
                task, all_records, context,
                context.get("review", {}), progress,
            )

            # 完成
            task.status = TaskStatus.COMPLETED
            task.completed_at = time.strftime("%Y-%m-%dT%H:%M:%S")
            task.total_records = len(all_records)
            self.store.save_task_to_file(task.task_id)
            self._emit(progress, type="task_complete", task_id=task.task_id,
                        summary=task.to_summary())
            return task

        except Exception as e:
            logger.exception("流水线执行失败")
            task.status = TaskStatus.FAILED
            task.errors.append(str(e))
            self.store.update_task(task)
            self._emit(progress, type="error", task_id=task.task_id,
                        message=str(e))
            return task

    # ========== 可重入状态机：用户反馈后从指定阶段重试 ==========

    async def run_resume(self, task: Task, from_stage: str,
                          progress: ProgressCallback | None = None) -> Task:
        """从指定阶段重试（可重入状态机，对齐 PROBLEM.md 加分项）。

        加载已持久化的 records + context，从 from_stage 运行到 review，
        然后 export。单轮执行，不进行多轮迭代（用户显式重试，单轮即可）。

        Args:
            task: 任务对象（需已完成过至少一轮，状态 completed/failed）
            from_stage: 起始阶段，取值 search/acquire/parse/clean/analyze/review
        """
        valid_stages = set(PIPELINE)
        if from_stage not in valid_stages:
            raise ValueError(
                f"不可重入阶段: {from_stage}，可选: {sorted(valid_stages)}")

        try:
            # 设置任务状态为对应阶段的 ING 状态
            stage_status_map = {
                "search": TaskStatus.SEARCHING,
                "acquire": TaskStatus.ACQUIRING,
                "parse": TaskStatus.PARSING,
                "clean": TaskStatus.CLEANING,
                "analyze": TaskStatus.ANALYZING,
                "review": TaskStatus.REVIEWING,
            }
            task.status = stage_status_map[from_stage]
            self._emit(progress, type="task_start", task_id=task.task_id,
                        research_goal=task.research_goal,
                        resume_from=from_stage)

            # 加载已持久化的 context 与 records
            context = self._load_context(task)
            records = list(self.store._records.get(task.task_id, []))
            logger.info("重入状态机：从 %s 阶段重试，加载 %d 条已有记录",
                        from_stage, len(records))

            # search 重试时清空已有记录重新检索；其余阶段保留前置阶段产出
            if from_stage == "search":
                records = []

            # 确定要运行的阶段子集
            stage_idx = PIPELINE.index(from_stage)
            resume_pipeline = PIPELINE[stage_idx:]
            self._emit(progress, type="stage_start", stage="resume",
                        message=f"从 {from_stage} 阶段重试，"
                                f"运行 {list(resume_pipeline)}")

            # 运行阶段子集（复用 _execute_stage_with_error_handling，
            # 保持与正常流水线一致的错误决策语义）
            stage_retries: dict[str, int] = {}
            for stage_name in resume_pipeline:
                if stage_name == "analyze" and not task.enable_analysis:
                    continue
                agent = self._get_agent(stage_name)
                if agent is None:
                    logger.warning("阶段 %s 未注册 Agent，跳过", stage_name)
                    continue
                decision = await self._execute_stage_with_error_handling(
                    task, stage_name, agent, records, context,
                    progress, stage_retries, round_idx=1)
                if decision == "fail":
                    raise RuntimeError(
                        f"致命错误：阶段 {stage_name} 失败且无法恢复")

            # export（与 run 一致）
            await self._stage_export(
                task, records, context,
                context.get("review", {}), progress,
            )

            task.status = TaskStatus.COMPLETED
            task.completed_at = time.strftime("%Y-%m-%dT%H:%M:%S")
            task.total_records = len(records)
            self.store.save_task_to_file(task.task_id)
            self._emit(progress, type="task_complete", task_id=task.task_id,
                        summary=task.to_summary(), resumed_from=from_stage)
            return task

        except Exception as e:
            logger.exception("重入流水线执行失败")
            task.status = TaskStatus.FAILED
            task.errors.append(str(e))
            self.store.update_task(task)
            self._emit(progress, type="error", task_id=task.task_id,
                        message=str(e))
            return task

    def _load_context(self, task: Task) -> dict:
        """从 final_data.json 加载已持久化的 context。"""
        out_dir = get_task_output_dir(task.task_id)
        data_file = out_dir / "final_data.json"
        if data_file.exists():
            try:
                with open(data_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                ctx = data.get("context", {})
                # 确保关键字段存在（fallback 到 task 对象）
                ctx.setdefault("entities", task.entities)
                ctx.setdefault("domain", task.domain)
                ctx.setdefault("search_queries", [task.research_goal])
                ctx.setdefault("recommended_sources",
                               ["pubmed", "openalex", "semantic_scholar"])
                ctx.setdefault("analysis_plan", "")
                return ctx
            except Exception as e:
                logger.warning("加载 context 失败，使用默认: %s", e)
        # 回退：从 task 对象构建最小 context
        return {
            "entities": task.entities,
            "domain": task.domain,
            "search_queries": [task.research_goal],
            "recommended_sources": ["pubmed", "openalex", "semantic_scholar"],
            "analysis_plan": "",
        }

    # ========== 人工确认点（TASK-014 人在回路） ==========

    def _needs_confirmation(self, task: Task, records: list[dict],
                             review: dict) -> bool:
        """判断是否需要暂停等待人工确认。

        触发条件（任一满足即触发）：
        - 记录为空
        - 审查质量标记为 low
        - 平均置信度 < 0.5
        """
        if not records:
            logger.info("触发确认点：记录为空")
            return True
        quality = (review.get("quality") or "").lower()
        if quality == "low":
            logger.info("触发确认点：审查质量 low")
            return True
        avg_conf = float(review.get("avg_confidence") or task.avg_confidence or 0)
        if avg_conf < 0.5:
            logger.info("触发确认点：平均置信度 %.3f < 0.5", avg_conf)
            return True
        return False

    def _build_checkpoint_payload(self, task: Task, records: list[dict],
                                    review: dict) -> dict:
        """构建人工确认检查点的 payload（供前端展示与决策）。"""
        low_conf_records = [
            {"record_id": r.get("record_id", ""),
             "source": (r.get("source_ref") or {}).get("source", ""),
             "confidence": r.get("extraction_confidence", 0),
             "fields": r.get("fields", {})}
            for r in records
            if (r.get("extraction_confidence") or 0) < 0.5
        ][:20]
        return {
            "checkpoint": "low_confidence",
            "task_id": task.task_id,
            "total_records": len(records),
            "avg_confidence": float(review.get("avg_confidence")
                                     or task.avg_confidence or 0),
            "review_quality": review.get("quality", "unknown"),
            "review_issues": review.get("issues", []),
            "review_recommendations": review.get("recommendations", []),
            "low_confidence_records": low_conf_records,
            "low_confidence_count": len(low_conf_records),
        }

    async def run_export(self, task: Task,
                          progress: ProgressCallback | None = None) -> Task:
        """用户 approve 后仅运行 export 阶段（TASK-014）。

        从 AWAITING_CONFIRMATION 状态恢复，加载已持久化的 records + context，
        执行 export 后标记 COMPLETED。
        """
        try:
            context = self._load_context(task)
            records = list(self.store._records.get(task.task_id, []))
            task.status = TaskStatus.REVIEWING
            self._emit(progress, type="task_start", task_id=task.task_id,
                        research_goal=task.research_goal,
                        resume_from="export_approved")
            logger.info("人工确认通过，任务 %s 进入 export（记录 %d 条）",
                        task.task_id, len(records))

            await self._stage_export(
                task, records, context,
                context.get("review", {}), progress,
            )

            task.status = TaskStatus.COMPLETED
            task.completed_at = time.strftime("%Y-%m-%dT%H:%M:%S")
            task.total_records = len(records)
            task.pending_checkpoint = None
            task.checkpoint_payload = {}
            self.store.save_task_to_file(task.task_id)
            self._emit(progress, type="task_complete", task_id=task.task_id,
                        summary=task.to_summary(), approved=True)
            return task
        except Exception as e:
            logger.exception("人工确认后 export 失败")
            task.status = TaskStatus.FAILED
            task.errors.append(str(e))
            self.store.update_task(task)
            self._emit(progress, type="error", task_id=task.task_id,
                        message=str(e))
            return task

    async def _run_pipeline_round(self, task: Task, context: dict,
                                   progress: ProgressCallback | None,
                                   round_idx: int) -> tuple[list[dict], dict]:
        """执行一轮完整 PIPELINE（search→acquire→parse→clean→analyze→review）。

        每轮从空 records 列表开始，避免重复处理历史记录。
        阶段失败时由 ErrorDecisionAgent 决策 retry/skip/escalate/fail。
        """
        records: list[dict] = []
        stage_retries: dict[str, int] = {}

        for stage_name in PIPELINE:
            if stage_name == "analyze" and not task.enable_analysis:
                continue

            agent = self._get_agent(stage_name)
            if agent is None:
                logger.warning("阶段 %s 未注册 Agent，跳过", stage_name)
                continue

            retry_count = stage_retries.get(stage_name, 0)
            decision = await self._execute_stage_with_error_handling(
                task, stage_name, agent, records, context, progress,
                stage_retries, round_idx)

            if decision is None:
                # 正常完成: records 已被 agent.execute 更新
                continue
            elif decision == "skip_stage":
                logger.info("阶段 %s 被跳过，继续流水线", stage_name)
                continue
            elif decision == "escalate":
                logger.warning("阶段 %s 降级继续", stage_name)
                continue
            elif decision == "fail":
                # 致命错误，冒泡到顶层
                raise RuntimeError(
                    f"致命错误：阶段 {stage_name} 失败且无法恢复")

        return records, context

    async def _execute_stage_with_error_handling(
            self, task: Task, stage_name: str, agent: BaseAgent,
            records: list[dict], context: dict,
            progress: ProgressCallback | None,
            stage_retries: dict[str, int],
            round_idx: int) -> str | None:
        """执行单阶段，带错误决策。返回 None=成功，否则返回最终 action。"""
        max_retries_per_stage = 2

        while True:
            retry_count = stage_retries.get(stage_name, 0)
            try:
                records, context = await agent.execute(
                    task, records, context, progress)
                return None  # 成功
            except Exception as e:
                logger.warning("阶段 %s 失败（第 %d 次）: %s",
                               stage_name, retry_count + 1, e)

                # 获取 ErrorDecisionAgent
                decision_agent = self._get_agent("error_decision")
                if decision_agent is None:
                    logger.warning("ErrorDecisionAgent 未注册，终止流水线")
                    raise

                # 类型收窄（ErrorDecisionAgent 已通过注册表实例化）
                assert isinstance(decision_agent, ErrorDecisionAgent)

                # 调用决策（ErrorDecisionAgent 的 decide() 不在 BaseAgent 接口中）
                decision = await decision_agent.decide(  # type: ignore[attr-defined]
                    task, stage_name, e, records, context,
                    retry_count, progress)

                action = decision.get("action", "fail")
                reason = decision.get("reason", "")

                logger.info("错误决策 [%s]: action=%s reason=%s",
                            stage_name, action, reason)

                if action == "retry":
                    stage_retries[stage_name] = retry_count + 1
                    if retry_count + 1 > max_retries_per_stage:
                        # 超过重试上限 → escalate
                        task.errors.append(
                            f"[{stage_name}] 重试上限({max_retries_per_stage})后仍失败: {e}")
                        self._emit(progress, type="stage_error",
                                    stage=stage_name, action="escalate",
                                    reason=f"重试 {max_retries_per_stage} 次后跳过",
                                    message=str(e)[:200])
                        return "escalate"
                    # 重试前短暂延迟（指数退避）
                    delay = min(2 ** retry_count, 8)  # 1s, 2s, 4s, 8s
                    logger.info("阶段 %s 将在 %ds 后重试", stage_name, delay)
                    await asyncio.sleep(delay)
                    continue  # 重试循环

                elif action == "skip_stage":
                    task.errors.append(
                        f"[{stage_name}] 跳过: {reason} - {str(e)[:100]}")
                    self._emit(progress, type="stage_error",
                                stage=stage_name, action="skip",
                                reason=reason, message=str(e)[:200])
                    return "skip_stage"

                elif action == "escalate":
                    task.errors.append(
                        f"[{stage_name}] 降级: {reason} - {str(e)[:100]}")
                    self._emit(progress, type="stage_error",
                                stage=stage_name, action="escalate",
                                reason=reason, message=str(e)[:200])
                    return "escalate"

                elif action == "fail":
                    task.errors.append(
                        f"[{stage_name}] 致命错误: {reason} - {str(e)[:200]}")
                    self._emit(progress, type="stage_error",
                                stage=stage_name, action="fail",
                                reason=reason, message=str(e)[:200])
                    return "fail"

    @staticmethod
    def _dedup_round(round_records: list[dict],
                      seen_ids: set[str]) -> list[dict]:
        """跨轮去重：过滤掉已见 record_id 的记录，更新 seen_ids。"""
        new: list[dict] = []
        for r in round_records:
            rid = r.get("record_id", "")
            if rid and rid in seen_ids:
                continue
            if rid:
                seen_ids.add(rid)
            new.append(r)
        return new

    def _get_agent(self, name: str) -> BaseAgent | None:
        """从 AgentRegistry 实例化阶段 Agent（注入 llm/tools/store）。"""
        return AgentRegistry.get(name, llm=self.llm,
                                  tools=self.tools, store=self.store)

    # ========== Stage 1: Planning（Orchestrator 直接持有） ==========

    async def _stage_planning(self, task: Task,
                               progress: ProgressCallback | None) -> dict:
        self._set_stage(task, "planning", StageStatus.RUNNING,
                        "LLM 正在分析研究目标...")
        self._emit(progress, type="stage_start", stage="planning",
                    message="正在分析研究目标，提取关键实体...")

        context: dict = {}
        if self.llm.is_available():
            prompt = f"""分析以下生物医学研究目标，提取关键实体。

研究目标：{task.research_goal}

请返回严格 JSON 格式：
{{
  "entities": {{
    "compounds": ["化合物/中药成分名称"],
    "genes": ["靶点基因符号"],
    "diseases": ["疾病名称"],
    "pathways": ["相关通路"]
  }},
  "domain": "tcm|oncology|pharmacology|molecular_biology|other",
  "search_queries": ["PubMed检索关键词1", "关键词2", ...],
  "recommended_sources": ["pubmed", "geo", "string", "kegg", "pdb", "tcmsp", "openalex", "semantic_scholar", ...],
  "analysis_plan": "建议的分析策略简述"
}}

注意：
- compounds 应包含中药复方中的主要活性成分（如有）
- genes 应包含已知的关键靶点基因
- search_queries 应包含中英文检索词
- recommended_sources 只能从以下选择：pubmed, openalex, semantic_scholar, geo, string, kegg, pdb, tcmsp, ncbi, clinicaltrials, tcga, drugbank, disgenet, pubchem"""

            try:
                result = await self._to_thread(
                    self.llm.chat_json,
                    [{"role": "user", "content": prompt}],
                    model=MODEL_TEXT,
                    temperature=0.3,
                )
                context["entities"] = result.get("entities", {})
                context["domain"] = result.get("domain", "other")
                context["search_queries"] = result.get(
                    "search_queries", [task.research_goal])
                context["recommended_sources"] = result.get(
                    "recommended_sources",
                    ["pubmed", "openalex", "semantic_scholar"])
                context["analysis_plan"] = result.get("analysis_plan", "")

                task.entities = context.get("entities", {})
                task.domain = context.get("domain", "")
                msg = (f"实体识别完成："
                       f"{sum(len(v) for v in task.entities.values())} 个实体，"
                       f"领域={task.domain}")
            except Exception as e:
                logger.warning("LLM 规划失败，使用默认: %s", e)
                context = self._default_planning(task)
                msg = f"LLM 规划失败，使用默认检索: {e}"
        else:
            context = self._default_planning(task)
            msg = "API Key 未配置，使用默认检索"

        self._set_stage(task, "planning", StageStatus.DONE, msg, records_count=0)
        self._emit(progress, type="stage_complete", stage="planning",
                    message=msg, context=context)
        self.store.update_task(task)
        return context

    def _default_planning(self, task: Task) -> dict:
        """无 LLM 时的默认规划。"""
        return {
            "entities": {"compounds": [], "genes": [],
                         "diseases": [], "pathways": []},
            "domain": task.domain_hint or "other",
            "search_queries": [task.research_goal],
            "recommended_sources": ["pubmed", "openalex", "semantic_scholar"],
            "analysis_plan": "",
        }

    # ========== Stage 8: Export（Orchestrator 直接持有） ==========

    async def _stage_export(self, task: Task, records: list[dict],
                            context: dict, review: dict,
                            progress: ProgressCallback | None):
        self._set_stage(task, "export", StageStatus.RUNNING,
                        "生成 CSV 和 LLM 研究报告...")
        self._emit(progress, type="stage_start", stage="export",
                    message="生成结构化输出和综合研究报告...")

        out_dir = get_task_output_dir(task.task_id)

        # Step 1: CSV 导出（所有记录平铺，供溯源审计）
        self._emit(progress, type="stage_progress", stage="export",
                    pct=0.2, message="CSV 导出中...")
        csv_file = out_dir / "data.csv"
        if records:
            result = await self._to_thread(self.tools.export_csv, records, csv_file)
            if not result.success:
                raise RuntimeError(f"CSV 导出失败: {result.error}")

        # Step 2: 多源整合 CSV（按实体类型分表，字段对齐，供研究分析）
        self._emit(progress, type="stage_progress", stage="export",
                    pct=0.4, message="生成多源整合 CSV...")
        merged_csv = self._write_merged_csv(records, out_dir / "merged_data.csv")

        # Step 3: LLM 生成综合研究报告（失败则整个任务失败，不回退旧模板）
        self._emit(progress, type="stage_progress", stage="export",
                    pct=0.6, message="LLM 生成综合研究报告中...")
        from app.agents.llm_reporter import LLMReporter
        reporter = LLMReporter(self.llm)
        html = await reporter.generate_report(
            research_goal=task.research_goal,
            records=records,
            entities=context.get("entities", {}),
            analysis=context.get("analysis", {}),
            review=review,
            task_id=task.task_id,
            domain=task.domain or "",
        )
        logger.info("LLM 报告生成成功，长度=%d", len(html))

        report_path = out_dir / "report.html"
        with open(report_path, "w", encoding="utf-8") as f:
            f.write(html)
        self.store.set_report(task.task_id, html)

        # Step 4: 保存完整 JSON 数据
        data_file = out_dir / "final_data.json"
        with open(data_file, "w", encoding="utf-8") as f:
            json.dump({
                "task": task.to_summary(),
                "records": records[:200],
                "context": {k: v for k, v in context.items()
                           if k not in ("analysis",)},
                "review": review,
            }, f, ensure_ascii=False, indent=2)

        msg = (f"导出完成：CSV({len(records)} 行) "
               f"+ 整合CSV({merged_csv[1]} 行) + LLM研究报告 + JSON 数据")
        self._set_stage(task, "export", StageStatus.DONE, msg)
        self._emit(progress, type="stage_complete", stage="export", message=msg)
        self.store.update_task(task)

    # ========== 辅助方法（Orchestrator 自身用，planning/export 阶段状态） ==========

    def _set_stage(self, task: Task, name: str, status: StageStatus,
                   message: str = "", **kwargs):
        """设置任务阶段状态（仅 planning/export，其余阶段由各 Agent 自管）。"""
        task.set_stage(name, status, message, **kwargs)
        if status == StageStatus.RUNNING:
            # export 阶段保持 REVIEWING 状态（随后设为 COMPLETED）
            if name == "planning":
                task.status = TaskStatus.PLANNING

    def _emit(self, progress: ProgressCallback | None, **kwargs):
        if progress:
            progress(kwargs)

    @staticmethod
    async def _to_thread(func, *args, **kwargs):
        """在线程池中运行同步阻塞函数，避免阻塞事件循环。"""
        return await asyncio.to_thread(func, *args, **kwargs)

    # ========== 多源整合 CSV 生成 ==========

    def _write_merged_csv(self, records: list[dict],
                          path: Path) -> tuple[int, int]:
        """生成多源整合 CSV — 按实体类型分组，字段对齐，便于研究分析。

        与 data.csv 的区别：
        - data.csv: 所有记录平铺，字段稀疏（适合溯源审计）
        - merged_data.csv: 按实体类型分组，字段对齐（适合研究分析）

        Returns:
            (分组数, 总行数)
        """
        if not records:
            path.write_text("", encoding="utf-8-sig")
            return (0, 0)

        groups: dict[str, list[dict]] = {}
        for r in records:
            etype = self._classify_record(r)
            groups.setdefault(etype, []).append(r)

        total_rows = 0
        with open(path, "w", newline="", encoding="utf-8-sig") as f:
            writer = csv.writer(f)
            for group_name, group_records in sorted(groups.items()):
                writer.writerow(
                    [f"=== {group_name.upper()} ({len(group_records)} 条) ==="])
                columns = self._get_group_columns(group_name, group_records)
                writer.writerow(columns)
                for r in group_records:
                    fields = r.get("fields", {})
                    src = r.get("source_ref", {})
                    row = []
                    for col in columns:
                        if col == "source_name":
                            row.append(src.get("source_name", ""))
                        elif col == "confidence":
                            row.append(f"{r.get('extraction_confidence', 0):.2f}")
                        elif col == "source_url":
                            row.append(src.get("url", src.get("doi", "")))
                        else:
                            val = fields.get(col, "")
                            if isinstance(val, (list, dict)):
                                val = json.dumps(val, ensure_ascii=False)
                            row.append(str(val) if val is not None else "")
                    writer.writerow(row)
                    total_rows += 1
                writer.writerow([])

        logger.info("整合CSV写入 %d 行 → %s", total_rows, path)
        return (len(groups), total_rows)

    @staticmethod
    def _classify_record(r: dict) -> str:
        """根据记录字段判断实体类型。"""
        fields = r.get("fields", {})
        src = r.get("source_ref", {}).get("source_name", "")
        if fields.get("title") or fields.get("pmid") or fields.get("arxiv_id"):
            return "literature"
        if fields.get("compound_name") or fields.get("ob") or fields.get("dl"):
            return "compound"
        if fields.get("gene_symbol") or fields.get("uniprot_id") or fields.get("gene_id"):
            return "gene"
        if fields.get("compound") and fields.get("target"):
            return "interaction"
        if fields.get("pathway_name") or fields.get("term") or fields.get("kegg_id"):
            return "pathway"
        if fields.get("log2fc") or fields.get("pvalue") or fields.get("adj_p"):
            return "expression"
        if src in ("pubmed", "openalex", "semantic_scholar", "arxiv"):
            return "literature"
        if src in ("string", "biogrid"):
            return "interaction"
        if src in ("kegg", "reactome"):
            return "pathway"
        if src in ("tcmsp", "pubchem", "drugbank"):
            return "compound"
        if src in ("uniprot", "hgnc", "ensembl"):
            return "gene"
        return "other"

    @staticmethod
    def _get_group_columns(group: str, records: list[dict]) -> list[str]:
        """根据分组类型返回标准化列头。"""
        base = ["source_name", "confidence", "source_url"]
        schemas = {
            "literature": ["title", "abstract", "authors", "year", "journal",
                          "doi", "pmid", "arxiv_id", "keywords"],
            "compound": ["compound_name", "herb", "ob", "dl", "smiles",
                         "mol_weight", "formula", "cas_number"],
            "gene": ["gene_symbol", "uniprot_id", "gene_id", "chromosome",
                     "function", "disease"],
            "interaction": ["compound", "target", "action", "score",
                           "evidence", "source_db"],
            "pathway": ["pathway_name", "term", "kegg_id", "p_value",
                       "adj_p_value", "gene_count", "genes", "category"],
            "expression": ["gene_symbol", "log2fc", "pvalue", "adj_p",
                          "fc", "stat", "phenotype"],
            "other": [],
        }
        cols = schemas.get(group, [])
        if not cols:
            seen = set(base)
            dynamic = []
            for r in records[:50]:
                for k in r.get("fields", {}):
                    if k not in seen:
                        dynamic.append(k)
                        seen.add(k)
            cols = dynamic[:15]
        return base + cols
