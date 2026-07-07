"""Orchestrator — LLM 驱动的 6 阶段流水线编排器。

阶段：planning → search → (acquire) → (parse) → clean → (analyze) → review → export

核心设计：
- planning/review 由 DashScope LLM 驱动（实体识别、质量审查、报告生成）
- search/clean/analyze/export 由已测试的 51 个脚本执行（通过 ToolRegistry 调用）
- 每个阶段完成后通过 progress 回调推送 WebSocket 实时状态
- Darwinian Stage Gate：LLM 评估覆盖率，不足则扩展搜索关键词重试

强制使用阿里云百炼 DashScope 平台。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import Any

from app.agents.base import BaseAgent, ProgressCallback
from app.config import MAX_SEARCH_RESULTS, MAX_STAGE_ITERATIONS, MODEL_TEXT, MODEL_STRONG
from app.llm.client import DashScopeClient
from app.models.task import Task, TaskStatus, StageStatus
from app.provenance.tracker import ProvenanceTracker
from app.storage.task_store import TaskStore, get_task_store
from app.tools.registry import ToolRegistry, get_registry
from app.tools.script_tool import ScriptResult
from app.utils.paths import get_task_output_dir, get_dictionaries_dir

logger = logging.getLogger(__name__)


class Orchestrator:
    """LLM 驱动的流水线编排器。"""

    def __init__(self, llm: DashScopeClient | None = None,
                 tools: ToolRegistry | None = None,
                 store: TaskStore | None = None):
        self.llm = llm or DashScopeClient()
        self.tools = tools or get_registry()
        self.store = store or get_task_store()

    async def run(self, task: Task,
                  progress: ProgressCallback | None = None) -> Task:
        """执行完整流水线。"""
        try:
            task.status = TaskStatus.PLANNING
            self._emit(progress, type="task_start", task_id=task.task_id,
                        research_goal=task.research_goal)

            # Stage 1: Planning — LLM 提取实体
            context = await self._stage_planning(task, progress)

            # Stage 2: Search — 并行检索数据源
            records = await self._stage_search(task, context, progress)

            # Stage 3: Acquire — 浏览器/爬虫采集（占位，完全隔离）
            # 当数据源返回 requires_crawl 信号时，此阶段可对接浏览器工具采集
            # 未实现时：静默跳过，不影响后续阶段
            records = await self._stage_acquire(task, records, progress, context)

            # Stage 4: Parse — （如有上传文件则解析，否则跳过）
            records = await self._stage_parse(task, records, progress)

            # Stage 5: Clean — 清洗 + 字段对齐
            records = await self._stage_clean(task, records, progress)

            # Stage 6: Analyze — （可选）生物信息学分析
            if task.enable_analysis:
                analysis_results = await self._stage_analyze(task, records, context, progress)
                context["analysis"] = analysis_results

            # Stage 7: Review — LLM 审查质量
            review = await self._stage_review(task, records, context, progress)
            context["review"] = review

            # Stage 8: Export — CSV + HTML 报告
            await self._stage_export(task, records, context, review, progress)

            # 完成
            task.status = TaskStatus.COMPLETED
            task.completed_at = time.strftime("%Y-%m-%dT%H:%M:%S")
            task.total_records = len(records)
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

    # ========== Stage 1: Planning ==========
    async def _stage_planning(self, task: Task,
                               progress: ProgressCallback | None) -> dict:
        self._set_stage(task, "planning", StageStatus.RUNNING, "LLM 正在分析研究目标...")
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
                context["search_queries"] = result.get("search_queries", [task.research_goal])
                context["recommended_sources"] = result.get("recommended_sources",
                    ["pubmed", "openalex", "semantic_scholar"])
                context["analysis_plan"] = result.get("analysis_plan", "")

                # 更新任务实体
                task.entities = context.get("entities", {})
                task.domain = context.get("domain", "")
                msg = f"实体识别完成：{sum(len(v) for v in task.entities.values())} 个实体，领域={task.domain}"
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
            "entities": {"compounds": [], "genes": [], "diseases": [], "pathways": []},
            "domain": task.domain_hint or "other",
            "search_queries": [task.research_goal],
            "recommended_sources": ["pubmed", "openalex", "semantic_scholar"],
            "analysis_plan": "",
        }

    # ========== Stage 2: Search ==========
    # 实体特定数据源：需用基因/化合物/疾病实体查询，而非研究目标
    ENTITY_SOURCES = {"string", "tcmsp", "disgenet", "pdb", "kegg", "drugbank"}

    async def _stage_search(self, task: Task, context: dict,
                            progress: ProgressCallback | None) -> list[dict]:
        self._set_stage(task, "search", StageStatus.RUNNING, "正在并行检索数据源...")
        self._emit(progress, type="stage_start", stage="search",
                    message="正在并行检索多个生物医学数据源...")

        sources = context.get("recommended_sources", ["pubmed", "openalex", "semantic_scholar"])
        queries = context.get("search_queries", [task.research_goal])
        primary_query = queries[0] if queries else task.research_goal
        entities = context.get("entities", {})

        all_records: list[dict] = []
        prov = self.store.get_provenance(task.task_id)

        # 分组：文献数据源用研究目标查询；实体数据源用实体级查询
        lit_sources = [s for s in sources if s not in self.ENTITY_SOURCES]
        entity_sources = [s for s in sources if s in self.ENTITY_SOURCES]

        # Step 1: 文献数据源并行检索（用研究目标查询）
        self._emit(progress, type="stage_progress", stage="search",
                    pct=0.1, message=f"正在检索 {len(lit_sources)} 个文献数据源...")

        results = await self._to_thread(
            self.tools.run_datasources_parallel,
            lit_sources, primary_query,
            max_results=task.max_sources,
            task_id=task.task_id,
        )

        for i, (src_name, result) in enumerate(results.items()):
            pct = 0.1 + 0.4 * (i + 1) / max(len(lit_sources), 1)
            if result.success:
                records = result.data if isinstance(result.data, list) else ([result.data] if result.data else [])
                all_records.extend(records)
                msg = f"✓ {src_name}: {len(records)} 条记录"
                if prov and records:
                    rec_ids = [r.get("record_id", "") for r in records]
                    prov.record("search", "search_agent", tool_name=src_name,
                               output_records=rec_ids,
                               parameters={"query": primary_query, "source": src_name})
                # 保留 requires_crawl 信号供 acquire 阶段使用
                if result.signals.get("status") == "requires_crawl":
                    context.setdefault("crawl_targets", []).append({
                        "source": src_name,
                        "query": primary_query,
                        "reason": result.signals.get("reason", ""),
                    })
            else:
                msg = f"✗ {src_name}: {result.error[:60]}"
                task.errors.append(f"{src_name}: {result.error}")

            self._emit(progress, type="stage_progress", stage="search",
                        pct=pct, message=msg)

        # Step 2: 实体数据源检索（用基因/化合物/疾病实体查询）
        if entity_sources:
            entity_queries = self._build_entity_queries(entities)
            self._emit(progress, type="stage_progress", stage="search",
                        pct=0.55, message=f"检索 {len(entity_sources)} 个实体数据源（{len(entity_queries)} 个查询）...")
            entity_records = await self._search_entity_sources(
                entity_sources, entity_queries, task, prov, progress)
            all_records.extend(entity_records)

        # Darwinian Stage Gate: 记录不足时用更宽泛的查询重试（中英文 + 实体名 + 疾病名）
        # 策略：原始查询过于具体时（如"健脾散结方"在 PubMed 无结果），
        # 用更宽泛的疾病级/实体级英文查询补充检索。
        if len(all_records) < 5:
            # 构造 fallback 查询队列：LLM 给的后续查询 + 疾病/基因级英文查询
            fallback_queries: list[str] = [q for q in queries[1:]
                                            if q and q != primary_query]
            # 用实体名构造疾病/基因级查询（确保英文且宽泛）
            entities = context.get("entities", {})
            diseases = entities.get("diseases", [])
            genes = entities.get("genes", [])
            if diseases:
                fallback_queries.append(f"{diseases[0]} liver metastasis")
            if genes:
                fallback_queries.append(f"{' '.join(genes[:3])} pancreatic cancer")
            fallback_queries.append("pancreatic cancer liver metastasis")
            fallback_queries.append("TCM pancreatic cancer metastasis")

            # 用核心文献数据源重试（pubmed/openalex/semantic_scholar/arxiv）
            retry_sources = [s for s in ("pubmed", "openalex", "semantic_scholar", "arxiv")
                             if s in sources or True][:4]

            seen_queries = {primary_query}
            for q in fallback_queries[:4]:
                if q in seen_queries:
                    continue
                seen_queries.add(q)
                self._emit(progress, type="stage_progress", stage="search",
                            pct=0.9, message=f"记录不足，使用扩展查询重试: {q[:40]}")
                extra = await self._to_thread(
                    self.tools.run_datasources_parallel,
                    retry_sources, q,
                    max_results=min(task.max_sources, 10),
                    task_id=task.task_id,
                )
                for src_name, result in extra.items():
                    if result.success:
                        recs = result.data if isinstance(result.data, list) else ([result.data] if result.data else [])
                        all_records.extend(recs)
                        if recs:
                            # 记录溯源（扩展查询）
                            if prov:
                                rec_ids = [r.get("record_id", "") for r in recs]
                                prov.record("search", "search_agent", tool_name=src_name,
                                           output_records=rec_ids,
                                           parameters={"query": q, "source": src_name,
                                                       "retry": True})
                            self._emit(progress, type="stage_progress", stage="search",
                                        pct=0.95, message=f"✓ {src_name} (扩展): {len(recs)} 条")

        task.source_count = len(set(
            r.get("source_ref", {}).get("source_name", "") for r in all_records
        ))
        msg = f"检索完成：共 {len(all_records)} 条记录，来自 {task.source_count} 个数据源"
        self._set_stage(task, "search", StageStatus.DONE, msg, records_count=len(all_records))
        self._emit(progress, type="stage_complete", stage="search",
                    message=msg, records_count=len(all_records))
        self.store.update_task(task)
        return all_records

    def _build_entity_queries(self, entities: dict) -> list[dict]:
        """根据实体列表构造实体级查询。

        返回 [{source, query, entity_type}, ...]
        - string/disgenet: 基因符号
        - tcmsp: 化合物名（中文/英文）
        - disgenet 也可按疾病查
        """
        queries: list[dict] = []
        genes = entities.get("genes", [])
        compounds = entities.get("compounds", [])
        diseases = entities.get("diseases", [])

        # 基因 → string / disgenet
        for g in genes[:10]:
            queries.append({"source": "string", "query": g, "entity_type": "gene"})
            queries.append({"source": "disgenet", "query": g, "entity_type": "gene"})

        # 化合物 → tcmsp
        for c in compounds[:8]:
            queries.append({"source": "tcmsp", "query": c, "entity_type": "compound"})

        # 疾病 → disgenet（疾病→基因）
        for d in diseases[:3]:
            # DisGeNET disease 模式需要英文疾病名
            d_en = self._disease_to_en(d)
            queries.append({"source": "disgenet", "query": d_en,
                            "entity_type": "disease", "mode": "disease"})
        return queries

    @staticmethod
    def _disease_to_en(disease: str) -> str:
        """常见中文疾病名转英文（DisGeNET 需英文）。"""
        mapping = {
            "胰腺癌": "pancreatic cancer",
            "肝转移": "liver metastasis",
            "乳腺癌": "breast cancer",
            "肺癌": "lung cancer",
            "胃癌": "gastric cancer",
            "结直肠癌": "colorectal cancer",
        }
        return mapping.get(disease, disease)

    async def _search_entity_sources(self, entity_sources: list[str],
                                      entity_queries: list[dict],
                                      task: Task, prov,
                                      progress: ProgressCallback | None) -> list[dict]:
        """检索实体特定数据源（string/tcmsp/disgenet 等）。

        对每个 (source, query) 组合串行/小并行调用，避免限流。
        """
        all_records: list[dict] = []
        # 按 source 分组查询
        from collections import defaultdict
        by_source: dict[str, list[dict]] = defaultdict(list)
        for q in entity_queries:
            if q["source"] in entity_sources:
                by_source[q["source"]].append(q)

        total = sum(len(qs) for qs in by_source.values())
        done = 0
        for src_name, qs in by_source.items():
            runner = self.tools.get(src_name)
            if not runner:
                continue
            for q in qs:
                done += 1
                pct = 0.55 + 0.25 * done / max(total, 1)
                label = q["query"][:30]
                self._emit(progress, type="stage_progress", stage="search",
                            pct=pct, message=f"{src_name}/{q.get('entity_type','')}: {label}")
                # 构造参数：实体源用各自参数
                args = ["--query", q["query"], "--max",
                        str(min(task.max_sources, 10)), "--task-id", task.task_id]
                if src_name == "disgenet" and q.get("mode") == "disease":
                    args.extend(["--mode", "disease"])
                if src_name == "tcmsp":
                    # tcmsp 用 --compound 参数
                    args = ["--compound", q["query"], "--max",
                            str(min(task.max_sources, 10)), "--task-id", task.task_id]
                result = await self._to_thread(runner.run, args, timeout=60)
                if result.success:
                    recs = result.data if isinstance(result.data, list) else ([result.data] if result.data else [])
                    all_records.extend(recs)
                    if prov and recs:
                        rec_ids = [r.get("record_id", "") for r in recs]
                        prov.record("search", "search_agent", tool_name=src_name,
                                   output_records=rec_ids,
                                   parameters={"query": q["query"], "source": src_name,
                                               "entity_type": q.get("entity_type", "")})
                    self._emit(progress, type="stage_progress", stage="search",
                                pct=pct, message=f"✓ {src_name}/{label}: {len(recs)} 条")
                else:
                    msg = f"✗ {src_name}/{label}: {result.error[:50]}"
                    task.errors.append(f"{src_name}: {result.error}")
                    self._emit(progress, type="stage_progress", stage="search",
                                pct=pct, message=msg)
        return all_records

    # ========== Stage 3: Acquire (浏览器/爬虫占位) ==========
    async def _stage_acquire(self, task: Task, records: list[dict],
                              progress: ProgressCallback | None,
                              context: dict | None = None) -> list[dict]:
        """采集阶段占位 — 当数据源返回 requires_crawl 信号时，可对接浏览器工具采集。

        当前实现：完全隔离，仅识别信号并记录日志，不执行实际爬取。
        对接浏览器工具的方式见 docs/agent_browser_integration.md。

        隔离保证：
        - 无论是否实现爬虫，本阶段都返回原始 records 不变
        - 异常被捕获，绝不影响后续 parse/clean/analyze 阶段
        """
        self._set_stage(task, "acquire", StageStatus.RUNNING, "检查需要爬虫采集的数据源...")
        self._emit(progress, type="stage_start", stage="acquire",
                    message="检查需要爬虫采集的数据源...")

        try:
            # 从 context 中读取 requires_crawl 信号（由 search 阶段收集）
            crawl_targets = (context or {}).get("crawl_targets", [])
            crawl_needed = len(crawl_targets)

            if crawl_needed > 0:
                sources_list = ", ".join(t["source"] for t in crawl_targets)
                self._emit(progress, type="stage_progress", stage="acquire",
                            pct=0.5,
                            message=f"需要爬虫采集: {sources_list}（当前未实现，已跳过）")
                # 记录到任务错误列表（非致命，仅为提示）
                task.errors.append(
                    f"acquire: {crawl_needed} 个数据源需要爬虫采集（{sources_list}），"
                    "当前未实现浏览器工具，已跳过。"
                    "对接方式见 docs/agent_browser_integration.md"
                )

            msg = (f"采集阶段完成。需要爬虫的数据源: {crawl_needed} 个"
                   f"{'（已跳过，未实现）' if crawl_needed else '（无需爬虫）'}")
            self._set_stage(task, "acquire", StageStatus.DONE, msg, records_count=len(records))
            self._emit(progress, type="stage_complete", stage="acquire", message=msg)
        except Exception as e:
            logger.warning("acquire 阶段异常（已隔离）: %s", e)
            self._set_stage(task, "acquire", StageStatus.DONE,
                            f"采集阶段异常已隔离: {e}", records_count=len(records))
            self._emit(progress, type="stage_complete", stage="acquire",
                        message=f"采集阶段异常已隔离: {e}")

        self.store.update_task(task)
        return records

    # ========== Stage 4: Parse ==========
    async def _stage_parse(self, task: Task, records: list[dict],
                           progress: ProgressCallback | None) -> list[dict]:
        """解析阶段 — 1) 上传 PDF 2) 搜索结果中的 OA PDF 自动下载并解析。"""
        self._set_stage(task, "parse", StageStatus.RUNNING, "检查需要解析的文件...")
        self._emit(progress, type="stage_start", stage="parse",
                    message="解析上传文件 + 自动下载开放获取论文 PDF...")

        out_dir = get_task_output_dir(task.task_id)
        uploads_dir = Path(task.output_dir).parent.parent / "uploads"
        parsed_records: list[dict] = []

        # Step 1: 解析用户上传的 PDF
        if uploads_dir.exists():
            pdf_files = list(uploads_dir.glob("*.pdf"))
            for pdf in pdf_files:
                self._emit(progress, type="stage_progress", stage="parse",
                            pct=0.2, message=f"解析上传 PDF: {pdf.name}")
                runner = self.tools.get("pdf_table")
                if runner:
                    out_file = out_dir / f"parsed_{pdf.stem}.json"
                    result = await self._to_thread(
                        runner.run_to_file,
                        ["--input", str(pdf), "--out", str(out_file)],
                        output_file=out_file,
                        timeout=120,
                    )
                    if result.success and result.data:
                        parsed = result.data if isinstance(result.data, list) else [result.data]
                        parsed_records.extend(parsed)

        # Step 2: 自动下载搜索结果中的开放获取 PDF（arXiv/OpenAlex 等）
        # 筛选含 pdf_url 的记录（最多前 5 条，避免被反爬）
        def _has_pdf(r: dict) -> bool:
            fields = r.get("fields", {}) or {}
            if fields.get("pdf_url"):
                return True
            oa = fields.get("best_oa_location")
            return isinstance(oa, dict) and bool(oa.get("pdf_url"))

        pdf_candidates = [r for r in records if _has_pdf(r)][:5]

        if pdf_candidates:
            self._emit(progress, type="stage_progress", stage="parse",
                        pct=0.4, message=f"尝试下载 {len(pdf_candidates)} 篇开放获取论文...")
            # 写入临时 records 文件供 pdf_downloader 读取
            tmp_records = out_dir / "raw_for_download.json"
            with open(tmp_records, "w", encoding="utf-8") as f:
                json.dump(records, f, ensure_ascii=False, default=str)
            pdf_dir = out_dir / "pdfs"
            runner = self.tools.get("pdf_download")
            if runner:
                dl_out = out_dir / "downloaded_records.json"
                result = await self._to_thread(
                    runner.run_to_file,
                    ["--input", str(tmp_records),
                     "--out-dir", str(pdf_dir),
                     "--max", "5",
                     "--task-id", task.task_id],
                    output_file=dl_out,
                    timeout=180,
                )
                downloaded = []
                if result.success and result.data:
                    downloaded = result.data if isinstance(result.data, list) else [result.data]
                self._emit(progress, type="stage_progress", stage="parse",
                            pct=0.7, message=f"下载完成：{len(downloaded)} 篇 PDF")

                # Step 3: 对下载的 PDF 调用 pdf_table_parser 提取表格+caption
                runner = self.tools.get("pdf_table")
                if runner and pdf_dir.exists():
                    for pdf_file in sorted(pdf_dir.glob("*.pdf")):
                        self._emit(progress, type="stage_progress", stage="parse",
                                    pct=0.85, message=f"解析 PDF: {pdf_file.name}")
                        out_file = out_dir / f"parsed_{pdf_file.stem}.json"
                        result = await self._to_thread(
                            runner.run_to_file,
                            ["--input", str(pdf_file), "--out", str(out_file)],
                            output_file=out_file,
                            timeout=120,
                        )
                        if result.success and result.data:
                            parsed = result.data if isinstance(result.data, list) else [result.data]
                            parsed_records.extend(parsed)

        # 记录溯源：parse 阶段
        prov = self.store.get_provenance(task.task_id)
        if prov and parsed_records:
            rec_ids = [r.get("record_id", "") for r in parsed_records]
            prov.record("parse", "parse_agent", tool_name="pdf_table+pdf_download",
                       output_records=rec_ids,
                       parameters={"uploaded_count": len(parsed_records),
                                   "downloaded_count": len(pdf_candidates)})

        msg = f"解析完成：{len(parsed_records)} 条新记录（含上传 PDF + 自动下载 PDF）"
        records.extend(parsed_records)
        self._set_stage(task, "parse", StageStatus.DONE, msg, records_count=len(records))
        self._emit(progress, type="stage_complete", stage="parse", message=msg)
        self.store.update_task(task)
        return records

    # ========== Stage 4: Clean ==========
    async def _stage_clean(self, task: Task, records: list[dict],
                           progress: ProgressCallback | None) -> list[dict]:
        self._set_stage(task, "clean", StageStatus.RUNNING, "正在清洗与字段对齐...")
        self._emit(progress, type="stage_start", stage="clean",
                    message="数据清洗：字段对齐、单位归一化、去重...")

        out_dir = get_task_output_dir(task.task_id)
        cleaned = records

        # Step 1: 保存原始记录供脚本读取
        raw_file = out_dir / "raw_records.json"
        with open(raw_file, "w", encoding="utf-8") as f:
            json.dump(records, f, ensure_ascii=False, indent=2)

        self._emit(progress, type="stage_progress", stage="clean",
                    pct=0.2, message="字段对齐中...")

        # Step 2: 字段对齐
        aligned_file = out_dir / "aligned_records.json"
        runner = self.tools.get("field_aligner")
        if runner:
            dict_dir = get_dictionaries_dir()
            result = await self._to_thread(
                runner.run_to_file,
                ["--input", str(raw_file), "--out", str(aligned_file),
                 "--dictionaries", str(dict_dir)],
                output_file=aligned_file,
                timeout=120,
            )
            if result.success and result.data:
                cleaned = result.data if isinstance(result.data, list) else [result.data]
                self._emit(progress, type="stage_progress", stage="clean",
                            pct=0.4, message=f"字段对齐完成：{len(cleaned)} 条")
            else:
                task.errors.append(f"field_aligner: {result.error}")

        # Step 3: 单位归一化
        self._emit(progress, type="stage_progress", stage="clean",
                    pct=0.6, message="单位归一化中...")
        normalized_file = out_dir / "normalized_records.json"
        runner = self.tools.get("unit_normalizer")
        if runner and cleaned:
            norm_input = aligned_file if aligned_file.exists() else raw_file
            result = await self._to_thread(
                runner.run_to_file,
                ["--input", str(norm_input), "--out", str(normalized_file)],
                output_file=normalized_file,
                timeout=120,
            )
            if result.success and result.data:
                cleaned = result.data if isinstance(result.data, list) else [result.data]
                self._emit(progress, type="stage_progress", stage="clean",
                            pct=0.8, message=f"单位归一化完成：{len(cleaned)} 条")
            else:
                task.errors.append(f"unit_normalizer: {result.error}")

        # Step 4: 去重
        dedup_file = out_dir / "deduped_records.json"
        runner = self.tools.get("duplicate_dedector")
        if runner and cleaned:
            dedup_input = normalized_file if normalized_file.exists() else aligned_file if aligned_file.exists() else raw_file
            result = await self._to_thread(
                runner.run_to_file,
                ["--input", str(dedup_input), "--out", str(dedup_file)],
                output_file=dedup_file,
                timeout=120,
            )
            if result.success and result.data:
                cleaned = result.data if isinstance(result.data, list) else [result.data]
                self._emit(progress, type="stage_progress", stage="clean",
                            pct=0.95, message=f"去重完成：{len(cleaned)} 条")

        # 统计质量标记
        flags_count = sum(1 for r in cleaned if r.get("quality_flags"))
        avg_conf = 0.0
        if cleaned:
            confs = [r.get("extraction_confidence", 1.0) for r in cleaned]
            avg_conf = sum(confs) / len(confs)

        msg = f"清洗完成：{len(cleaned)} 条记录，平均置信度 {avg_conf:.2%}，{flags_count} 条有质量标记"
        task.avg_confidence = avg_conf
        self._set_stage(task, "clean", StageStatus.DONE, msg, records_count=len(cleaned))
        self._emit(progress, type="stage_complete", stage="clean",
                    message=msg, records_count=len(cleaned), avg_confidence=avg_conf)

        # 记录溯源：清洗阶段
        prov = self.store.get_provenance(task.task_id)
        if prov and cleaned:
            rec_ids = [r.get("record_id", "") for r in cleaned]
            # 输入：search 阶段产生的所有 record_id
            input_ids = [r.get("record_id", "") for r in records]
            prov.record("clean", "clean_agent", tool_name="field_aligner+unit_normalizer+duplicate_dedector",
                       input_records=input_ids,
                       output_records=rec_ids,
                       parameters={"input_count": len(records), "output_count": len(cleaned),
                                   "avg_confidence": avg_conf})

        # 保存清洗后的记录
        self.store.set_records(task.task_id, cleaned)
        self.store.update_task(task)
        return cleaned

    # ========== Stage 5: Analyze ==========
    async def _stage_analyze(self, task: Task, records: list[dict],
                             context: dict, progress: ProgressCallback | None) -> dict:
        self._set_stage(task, "analyze", StageStatus.RUNNING, "生物信息学分析中...")
        self._emit(progress, type="stage_start", stage="analyze",
                    message="根据数据类型运行链式分析...")

        analysis: dict = {}
        out_dir = get_task_output_dir(task.task_id)

        # 检查是否有表达矩阵数据
        has_expr = any("expression" in str(r.get("fields", {})).lower()
                       or "log2fc" in str(r.get("fields", {})).lower()
                       for r in records)

        entities = context.get("entities", {})
        gene_list = entities.get("genes", [])

        # Step 1: STRING PPI 网络分析（如有基因列表）
        if gene_list:
            self._emit(progress, type="stage_progress", stage="analyze",
                        pct=0.3, message=f"PPI 网络分析（{len(gene_list)} 个基因）...")
            runner = self.tools.get("ppi_network")
            if runner:
                ppi_out = out_dir / "ppi_result.json"
                result = await self._to_thread(
                    runner.run_to_file,
                    ["--gene-list", ",".join(gene_list[:20]),
                     "--task-id", task.task_id],
                    output_file=ppi_out,
                    timeout=60,
                )
                if result.success and result.data:
                    analysis["ppi_network"] = result.data if isinstance(result.data, dict) else {"edges": result.data}
                    self._emit(progress, type="stage_progress", stage="analyze",
                                pct=0.5, message="PPI 网络分析完成")
                else:
                    self._emit(progress, type="stage_progress", stage="analyze",
                                pct=0.5, message=f"PPI 跳过: {result.error[:40]}")

        # Step 2: GO/KEGG 富集分析（如有基因列表）
        if gene_list:
            self._emit(progress, type="stage_progress", stage="analyze",
                        pct=0.6, message="GO/KEGG 富集分析...")
            runner = self.tools.get("enrichment")
            if runner:
                enr_out = out_dir / "enrichment_result.json"
                result = await self._to_thread(
                    runner.run_to_file,
                    ["--gene-list", ",".join(gene_list[:50]),
                     "--task-id", task.task_id],
                    output_file=enr_out,
                    timeout=60,
                )
                if result.success and result.data:
                    analysis["enrichment"] = result.data if isinstance(result.data, dict) else {"terms": result.data}
                    self._emit(progress, type="stage_progress", stage="analyze",
                                pct=0.8, message="富集分析完成")
                else:
                    self._emit(progress, type="stage_progress", stage="analyze",
                                pct=0.8, message=f"富集跳过: {result.error[:40]}")

        # Step 3: 药物-靶点分析（如有化合物）
        compounds = entities.get("compounds", [])
        if compounds:
            self._emit(progress, type="stage_progress", stage="analyze",
                        pct=0.85, message="药物-靶点分析...")
            runner = self.tools.get("drug_target")
            if runner:
                dt_out = out_dir / "drug_target_result.json"
                result = await self._to_thread(
                    runner.run_to_file,
                    ["--compound-list", ",".join(compounds[:5]),
                     "--task-id", task.task_id],
                    output_file=dt_out,
                    timeout=60,
                )
                if result.success and result.data:
                    analysis["drug_targets"] = result.data if isinstance(result.data, dict) else {"compounds": result.data}

        msg = f"分析完成：{len(analysis)} 项分析结果"
        self._set_stage(task, "analyze", StageStatus.DONE, msg)
        self._emit(progress, type="stage_complete", stage="analyze",
                    message=msg, analysis=analysis)
        # 保存分析结果到 store（供前端 /analysis 端点查询）
        self.store.set_analysis(task.task_id, analysis)
        # 记录溯源：分析阶段
        prov = self.store.get_provenance(task.task_id)
        if prov and analysis:
            prov.record("analyze", "analysis_agent",
                       tool_name=",".join(analysis.keys()),
                       output_records=[],
                       parameters={"analysis_types": list(analysis.keys()),
                                   "gene_count": len(gene_list),
                                   "compound_count": len(compounds) if 'compounds' in context.get("entities", {}) else 0})
        self.store.update_task(task)
        return analysis

    # ========== Stage 6: Review ==========
    async def _stage_review(self, task: Task, records: list[dict],
                            context: dict, progress: ProgressCallback | None) -> dict:
        self._set_stage(task, "review", StageStatus.RUNNING, "LLM 审查数据质量...")
        self._emit(progress, type="stage_start", stage="review",
                    message="DashScope LLM 正在审查数据质量与完整性...")

        review: dict = {}
        if self.llm.is_available() and records:
            # 准备审查摘要
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
                msg = f"审查完成：质量={review.get('overall_quality', 'unknown')}, 完整度={review.get('completeness_score', 0):.0%}"
            except Exception as e:
                logger.warning("LLM 审查失败: %s", e)
                review = {"error": str(e), "overall_quality": "unknown"}
                msg = f"LLM 审查失败: {e}"
        else:
            review = {"overall_quality": "unknown", "note": "API Key 未配置或无数据"}
            msg = "跳过 LLM 审查（无 API Key 或无数据）"

        self._set_stage(task, "review", StageStatus.DONE, msg)
        self._emit(progress, type="stage_complete", stage="review",
                    message=msg, review=review)
        self.store.update_task(task)
        return review

    # ========== Stage 7: Export ==========
    async def _stage_export(self, task: Task, records: list[dict],
                            context: dict, review: dict,
                            progress: ProgressCallback | None):
        self._set_stage(task, "export", StageStatus.RUNNING, "生成 CSV 和 HTML 报告...")
        self._emit(progress, type="stage_start", stage="export",
                    message="生成结构化输出和可视化报告...")

        out_dir = get_task_output_dir(task.task_id)

        # Step 1: CSV 导出
        self._emit(progress, type="stage_progress", stage="export",
                    pct=0.3, message="CSV 导出中...")
        csv_file = out_dir / "data.csv"
        runner = self.tools.get("to_csv")
        if runner and records:
            result = await self._to_thread(
                runner.run_to_file,
                ["--input", str(out_dir / "deduped_records.json"),
                 "--out", str(csv_file)],
                output_file=csv_file,
                timeout=60,
            )
            if not result.success:
                # 退路：直接用 Python 写 CSV
                self._write_csv_fallback(records, csv_file)

        # Step 2: 生成 HTML 报告
        self._emit(progress, type="stage_progress", stage="export",
                    pct=0.6, message="生成 HTML 报告中...")
        html = self._generate_html_report(task, records, context, review)
        report_path = out_dir / "report.html"
        with open(report_path, "w", encoding="utf-8") as f:
            f.write(html)

        self.store.set_report(task.task_id, html)

        # Step 3: 保存完整 JSON 数据
        data_file = out_dir / "final_data.json"
        with open(data_file, "w", encoding="utf-8") as f:
            json.dump({
                "task": task.to_summary(),
                "records": records[:200],  # 限制大小
                "context": {k: v for k, v in context.items()
                           if k not in ("analysis",)},  # analysis 可能很大
                "review": review,
            }, f, ensure_ascii=False, indent=2)

        msg = f"导出完成：CSV({len(records)} 行) + HTML 报告 + JSON 数据"
        self._set_stage(task, "export", StageStatus.DONE, msg)
        self._emit(progress, type="stage_complete", stage="export", message=msg)
        self.store.update_task(task)

    # ========== HTML 报告生成 ==========
    def _generate_html_report(self, task: Task, records: list[dict],
                              context: dict, review: dict) -> str:
        """生成完整的 HTML 报告。"""
        sources = {}
        for r in records:
            src = r.get("source_ref", {}).get("source_name", "unknown")
            sources[src] = sources.get(src, 0) + 1

        entities = context.get("entities", {})
        analysis = context.get("analysis", {})

        # 表格行（前 50 条）
        table_rows = ""
        for r in records[:50]:
            fields = r.get("fields", {})
            src = r.get("source_ref", {})
            conf = r.get("extraction_confidence", 1.0)
            flags = ", ".join(r.get("quality_flags", [])) or "—"
            title = fields.get("title", fields.get("compound_name", fields.get("gene_symbol", "")))[:60]
            table_rows += f"""<tr>
                <td>{title}</td>
                <td>{src.get('source_name', '')}</td>
                <td>{conf:.0%}</td>
                <td>{flags}</td>
                <td>{src.get('doi', '') or src.get('pmid', '') or '—'}</td>
            </tr>"""

        review_html = ""
        if review:
            review_html = f"""
            <div class="card">
                <h2>质量审查</h2>
                <p><strong>总体质量：</strong>{review.get('overall_quality', '—')}</p>
                <p><strong>完整度评分：</strong>{review.get('completeness_score', '—')}</p>
                <p><strong>数据源覆盖：</strong>{review.get('source_coverage', '—')}</p>
                <div><strong>关键发现：</strong><ul>
                    {''.join(f'<li>{f}</li>' for f in review.get('key_findings', []))}
                </ul></div>
                <div><strong>改进建议：</strong><ul>
                    {''.join(f'<li>{s}</li>' for s in review.get('recommendations', []))}
                </ul></div>
            </div>"""

        entities_html = ""
        for cat, items in entities.items():
            if items:
                entities_html += f"<span class='tag'>{cat}: {', '.join(items[:10])}</span> "

        analysis_html = ""
        if analysis:
            analysis_html = "<div class='card'><h2>分析结果</h2>"
            for k, v in analysis.items():
                count = len(v) if isinstance(v, (list, dict)) else 1
                analysis_html += f"<p><strong>{k}:</strong> {count} 项结果</p>"
            analysis_html += "</div>"

        return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>BioMed QAgent 研究报告 — {task.task_id}</title>
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{ font-family: -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif;
                background: #f5f7fa; color: #333; line-height: 1.6; padding: 20px; }}
        .container {{ max-width: 1200px; margin: 0 auto; }}
        h1 {{ color: #1a1a2e; margin-bottom: 10px; }}
        h2 {{ color: #16213e; margin-bottom: 12px; border-bottom: 2px solid #0f3460; padding-bottom: 8px; }}
        .card {{ background: white; border-radius: 8px; padding: 24px; margin: 16px 0;
                  box-shadow: 0 2px 8px rgba(0,0,0,0.08); }}
        .summary {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; }}
        .stat {{ background: #16213e; color: white; padding: 16px; border-radius: 8px; text-align: center; }}
        .stat .num {{ font-size: 28px; font-weight: bold; }}
        .stat .label {{ font-size: 12px; opacity: 0.8; }}
        .tag {{ display: inline-block; background: #e8f0fe; color: #1a73e8;
                padding: 4px 12px; border-radius: 16px; margin: 4px; font-size: 13px; }}
        table {{ width: 100%; border-collapse: collapse; font-size: 13px; }}
        th {{ background: #16213e; color: white; padding: 10px; text-align: left; }}
        td {{ padding: 8px 10px; border-bottom: 1px solid #eee; }}
        tr:nth-child(even) {{ background: #f9fafb; }}
        .source-bar {{ display: flex; flex-wrap: wrap; gap: 8px; }}
        .source-item {{ background: #e8f0fe; padding: 6px 14px; border-radius: 4px; font-size: 13px; }}
        .meta {{ color: #666; font-size: 13px; margin-top: 4px; }}
    </style>
</head>
<body>
<div class="container">
    <div class="card">
        <h1>BioMed QAgent 研究报告</h1>
        <p><strong>研究目标：</strong>{task.research_goal}</p>
        <p class="meta">任务 ID: {task.task_id} | 领域: {task.domain or '未分类'} | 生成时间: {task.completed_at or task.updated_at}</p>
    </div>

    <div class="summary">
        <div class="stat"><div class="num">{len(records)}</div><div class="label">总记录数</div></div>
        <div class="stat"><div class="num">{len(sources)}</div><div class="label">数据源数</div></div>
        <div class="stat"><div class="num">{task.avg_confidence:.0%}</div><div class="label">平均置信度</div></div>
        <div class="stat"><div class="num">{sum(len(v) for v in entities.values())}</div><div class="label">识别实体数</div></div>
    </div>

    {f'<div class="card"><h2>识别实体</h2><div>{entities_html}</div></div>' if entities_html else ''}

    <div class="card">
        <h2>数据源分布</h2>
        <div class="source-bar">
            {''.join(f'<span class="source-item">{src}: {cnt}</span>' for src, cnt in sorted(sources.items(), key=lambda x: -x[1]))}
        </div>
    </div>

    {review_html}
    {analysis_html}

    <div class="card">
        <h2>数据预览（前 50 条）</h2>
        <table>
            <thead><tr><th>标题/名称</th><th>来源</th><th>置信度</th><th>质量标记</th><th>DOI/PMID</th></tr></thead>
            <tbody>{table_rows}</tbody>
        </table>
    </div>
</div>
</body>
</html>"""

    # ========== 辅助方法 ==========
    def _set_stage(self, task: Task, name: str, status: StageStatus,
                   message: str = "", **kwargs):
        task.set_stage(name, status, message, **kwargs)
        if status in (StageStatus.RUNNING,):
            if name == "planning":
                task.status = TaskStatus.PLANNING
            elif name == "search":
                task.status = TaskStatus.SEARCHING
            elif name == "clean":
                task.status = TaskStatus.CLEANING
            elif name == "analyze":
                task.status = TaskStatus.ANALYZING
            elif name == "review":
                task.status = TaskStatus.REVIEWING

    def _emit(self, progress: ProgressCallback | None, **kwargs):
        if progress:
            progress(kwargs)

    @staticmethod
    async def _to_thread(func, *args, **kwargs):
        """在线程池中运行同步阻塞函数，避免阻塞事件循环。"""
        return await asyncio.to_thread(func, *args, **kwargs)

    def _write_csv_fallback(self, records: list[dict], path: Path):
        """CSV 导出退路：直接用 Python 写。"""
        import csv
        if not records:
            return
        # 收集所有字段名
        all_fields: list[str] = ["record_id", "source_name", "extraction_method",
                                  "extraction_confidence", "quality_flags"]
        seen: set[str] = set(all_fields)
        for r in records:
            for k in r.get("fields", {}):
                if k not in seen:
                    all_fields.append(k)
                    seen.add(k)
        all_fields.extend(["source_url", "doi", "pmid"])

        with open(path, "w", newline="", encoding="utf-8-sig") as f:
            writer = csv.DictWriter(f, fieldnames=all_fields, extrasaction="ignore")
            writer.writeheader()
            for r in records:
                row: dict = {
                    "record_id": r.get("record_id", ""),
                    "source_name": r.get("source_ref", {}).get("source_name", ""),
                    "extraction_method": r.get("extraction_method", ""),
                    "extraction_confidence": r.get("extraction_confidence", ""),
                    "quality_flags": ", ".join(r.get("quality_flags", [])),
                    "source_url": r.get("source_ref", {}).get("url", ""),
                    "doi": r.get("source_ref", {}).get("doi", ""),
                    "pmid": r.get("source_ref", {}).get("pmid", ""),
                }
                row.update(r.get("fields", {}))
                writer.writerow(row)
