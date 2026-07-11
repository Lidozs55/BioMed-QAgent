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
import json
import logging
import time

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
    - 追查循环调度（方案 A 隐性循环：reviewer 提取追查任务 → 针对性 search→parse → 重跑分析）

    结构：
        planning → [单轮 search→acquire→parse→clean→analyze→review]
        → [追查循环（最多 MAX_FOLLOWUP_ROUNDS 轮）] → export
    """

    # 追查循环最大轮数（防止无限循环）
    MAX_FOLLOWUP_ROUNDS = 3

    def __init__(self, llm: DashScopeClient | None = None,
                 tools: ToolRegistry | None = None,
                 store: TaskStore | None = None):
        self.llm = llm or DashScopeClient()
        self.tools = tools or get_registry()
        self.store = store or get_task_store()
        # 注册所有阶段 Agent（触发 @AgentRegistry.register）
        register_all_agents()
        # ErrorDecisionAgent 是决策器（非阶段 Agent），直接实例化持有
        self._error_decision = ErrorDecisionAgent(
            llm=self.llm, tools=self.tools, store=self.store)

    async def run(self, task: Task,
                  progress: ProgressCallback | None = None) -> Task:
        """执行完整流水线（单轮 + 追查循环）。

        结构：
            planning → [单轮完整 search→acquire→parse→clean→analyze→review]
            → [追查循环（最多 MAX_FOLLOWUP_ROUNDS 轮）:
                reviewer 提取 followup_tasks → followup search→parse
                → 重跑 clean→analyze→review]
            → 人工确认点 → export
        """
        try:
            task.status = TaskStatus.PLANNING
            self._emit(progress, type="task_start", task_id=task.task_id,
                        research_goal=task.research_goal)

            # Stage 1: Planning — Orchestrator 直接持有（LLM 提取实体）
            context = await self._stage_planning(task, progress)
            context["query_log"] = []  # 全局查询日志（第一轮 + followup 都记录）

            # Stage 2-7: 单轮完整 PIPELINE
            all_records, context = await self._run_pipeline_round(
                task, context, progress, round_idx=1)
            task.total_records = len(all_records)
            task.current_round = 1
            self.store.update_task(task)
            logger.info("第一轮完成：共 %d 条记录", len(all_records))

            # Stage 8: 追查循环（方案 A 隐性循环）
            all_records, context = await self._run_followup_loop(
                task, all_records, context, progress)

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

            # Stage 9: Export — Orchestrator 直接持有（CSV + LLM 报告）
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

    # ========== 追查循环（方案 A 隐性循环） ==========

    async def _run_followup_loop(self, task: Task, all_records: list[dict],
                                  context: dict,
                                  progress: ProgressCallback | None
                                  ) -> tuple[list[dict], dict]:
        """追查循环：reviewer 提取 followup_tasks → 针对性 search→parse → 重跑 clean→analyze→review。

        收敛保障：
        1. reviewer 无追查任务 → 收敛
        2. 硬性上限 MAX_FOLLOWUP_ROUNDS 轮
        3. 已失败查询不重复追查（reviewer 内部过滤）
        """
        seen_ids: set[str] = {r.get("record_id", "") for r in all_records}

        for followup_idx in range(1, self.MAX_FOLLOWUP_ROUNDS + 1):
            followup_tasks = context.get("followup_tasks", [])
            if not followup_tasks:
                logger.info("追查循环收敛：无追查任务")
                break

            self._emit(progress, type="followup_round",
                        round=followup_idx,
                        max_rounds=self.MAX_FOLLOWUP_ROUNDS,
                        tasks_count=len(followup_tasks))
            logger.info("追查第 %d 轮：%d 个追查任务",
                        followup_idx, len(followup_tasks))

            # 构造追查 context
            followup_queries = [t.get("query", "") for t in followup_tasks
                                if t.get("query")]
            # 追查目标实体合并到 context["entities"]
            for t in followup_tasks:
                target = t.get("target_entities", {}) or {}
                if "entities" not in context:
                    context["entities"] = {"genes": [], "compounds": [],
                                           "diseases": [], "pathways": []}
                existing_genes = set(context["entities"].get("genes", []))
                existing_compounds = set(
                    context["entities"].get("compounds", []))
                existing_genes.update(target.get("genes", []) or [])
                existing_compounds.update(target.get("compounds", []) or [])
                context["entities"]["genes"] = sorted(existing_genes)
                context["entities"]["compounds"] = sorted(existing_compounds)

            followup_context = dict(context)
            followup_context["followup_mode"] = True
            followup_context["search_queries"] = followup_queries
            # 追查用精简数据源（文献为主）
            followup_context["recommended_sources"] = [
                s for s in context.get("recommended_sources",
                    ["pubmed", "europepmc"])
                if s not in ("string", "tcmsp", "disgenet", "pdb",
                             "kegg", "drugbank")]

            # 追查 search→parse（复用 Agent，followup_mode 用独立 stage 名）
            search_agent = self._get_agent("search")
            parser_agent = self._get_agent("parse")
            if search_agent is None or parser_agent is None:
                logger.warning("追查所需 Agent 未注册，跳过追查")
                break

            try:
                followup_records, followup_context = await search_agent.execute(
                    task, [], followup_context, progress)
                followup_records, followup_context = await parser_agent.execute(
                    task, followup_records, followup_context, progress)
            except Exception as e:
                logger.exception("追查第 %d 轮失败: %s", followup_idx, e)
                task.errors.append(f"追查第{followup_idx}轮失败: {e}")
                break

            # 去重后合并到 all_records
            new_records = []
            for r in followup_records:
                rid = r.get("record_id", "")
                if rid and rid not in seen_ids:
                    seen_ids.add(rid)
                    new_records.append(r)
            all_records.extend(new_records)
            task.total_records = len(all_records)
            task.current_round = followup_idx + 1
            self.store.update_task(task)
            logger.info("追查第 %d 轮完成：新增 %d 条，累计 %d 条",
                        followup_idx, len(new_records), len(all_records))

            # 同步 query_log 回主 context
            context["query_log"] = followup_context.get("query_log",
                context.get("query_log", []))

            # 重跑 clean→analyze→review（用合并后的全量记录）
            context["followup_mode"] = False  # 重跑分析阶段用正常 stage 名
            clean_agent = self._get_agent("clean")
            analyze_agent = self._get_agent("analyze")
            review_agent = self._get_agent("review")

            try:
                if clean_agent:
                    all_records, context = await clean_agent.execute(
                        task, all_records, context, progress)
                if analyze_agent:
                    all_records, context = await analyze_agent.execute(
                        task, all_records, context, progress)
                if review_agent:
                    all_records, context = await review_agent.execute(
                        task, all_records, context, progress)
            except Exception as e:
                logger.exception("追查后重跑分析失败: %s", e)
                task.errors.append(f"追查后重跑分析失败: {e}")
                break

            # review 后 context["followup_tasks"] 已更新，循环将检查是否收敛

        # 追查循环结束后清空 followup_tasks 避免重复
        context["followup_tasks"] = []
        return all_records, context

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
                records, context, decision = await self._execute_stage_with_error_handling(
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

            records, context, decision = await self._execute_stage_with_error_handling(
                task, stage_name, agent, records, context, progress,
                stage_retries, round_idx)

            if decision is None:
                # 正常完成: records/context 已回写
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
            round_idx: int) -> tuple[list[dict], dict, str | None]:
        """执行单阶段，带错误决策。

        返回 (records, context, decision)：
        - decision=None 表示成功，records/context 已被 agent.execute 更新
        - decision=skip_stage/escalate/fail 表示错误决策结果
        """
        max_retries_per_stage = 2

        while True:
            retry_count = stage_retries.get(stage_name, 0)
            try:
                records, context = await agent.execute(
                    task, records, context, progress)
                return records, context, None  # 成功
            except Exception as e:
                # 调用 ErrorDecisionAgent 决策（直接持有实例，非阶段 Agent）
                decision = await self._error_decision.decide(
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
                        return records, context, "escalate"
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
                    return records, context, "skip_stage"

                elif action == "escalate":
                    task.errors.append(
                        f"[{stage_name}] 降级: {reason} - {str(e)[:100]}")
                    self._emit(progress, type="stage_error",
                                stage=stage_name, action="escalate",
                                reason=reason, message=str(e)[:200])
                    return records, context, "escalate"

                elif action == "fail":
                    task.errors.append(
                        f"[{stage_name}] 致命错误: {reason} - {str(e)[:200]}")
                    self._emit(progress, type="stage_error",
                                stage=stage_name, action="fail",
                                reason=reason, message=str(e)[:200])
                    return records, context, "fail"

    @staticmethod
    def _dedup_round(round_records: list[dict],
                      seen_ids: set[str]) -> list[dict]:
        """跨轮去重：委托 BaseAgent._dedup_by_id（避免与 BaseAgent 重复实现）。"""
        return BaseAgent._dedup_by_id(round_records, seen_ids)

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
  "recommended_sources": ["pubmed", "geo", "string", "kegg", "pdb", "tcmsp", "openalex", "semantic_scholar", "europepmc", ...],
  "analysis_plan": "建议的分析策略简述"
}}

注意：
- compounds 应包含中药复方中的主要活性成分（如有）
- genes 应包含已知的关键靶点基因
- search_queries 应包含中英文检索词
- recommended_sources 只能从以下选择：pubmed, openalex, semantic_scholar, europepmc, geo, string, kegg, pdb, tcmsp, ncbi, clinicaltrials, tcga, drugbank, disgenet, pubchem
- europepmc 是国内网络最稳定的 OA 文献源，建议优先包含"""

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
        merged_result = await self._to_thread(
            self.tools.write_merged_csv, records, out_dir / "merged_data.csv")
        if not merged_result.success:
            raise RuntimeError(f"整合 CSV 导出失败: {merged_result.error}")
        merged_rows = (merged_result.data or {}).get("rows", 0)

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
               f"+ 整合CSV({merged_rows} 行) + LLM研究报告 + JSON 数据")
        self._set_stage(task, "export", StageStatus.DONE, msg)
        self._emit(progress, type="stage_complete", stage="export", message=msg)
        self.store.update_task(task)

    # ========== 辅助方法（Orchestrator 自身用，planning/export 阶段状态） ==========

    def _set_stage(self, task: Task, name: str, status: StageStatus,
                   message: str = "", **kwargs):
        """设置任务阶段状态（委托 BaseAgent._set_stage，仅 planning/export 由 Orchestrator 调用）。"""
        BaseAgent._set_stage(self, task, name, status, message, **kwargs)

    def _emit(self, progress: ProgressCallback | None, **kwargs):
        """推送进度事件（委托 BaseAgent._emit）。"""
        BaseAgent._emit(self, progress, **kwargs)

    @staticmethod
    async def _to_thread(func, *args, **kwargs):
        """在线程池中运行同步阻塞函数（委托 BaseAgent._to_thread）。"""
        return await BaseAgent._to_thread(func, *args, **kwargs)
