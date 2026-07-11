"""Search Agent — API 数据源并行检索。

从 Orchestrator._stage_search 迁入，职责：
- 文献数据源多查询并行检索（用 queries[:5] 而非 queries[0]，提升覆盖率）
- 实体数据源用基因/化合物/疾病实体检索
- 引用追溯：对高被引种子文献追溯参考文献/被引文献（系统综述能力）
- Darwinian Stage Gate：记录不足或相关性低时用组合查询 + MeSH 重试
- 收集 requires_crawl 信号供 AcquireAgent 使用
- 跨查询去重（按 record_id），避免后续阶段处理重复记录

改进来源：docs/literature_search_gap_analysis.md
- P0: 多查询并行 + max_results 提升 + fallback 阈值（已实施）
- P1: 组合查询（gene×disease, compound×disease）+ 引用追溯
- P2: MeSH 术语查询 + 智能 fallback（数量 + 相关性双维度）
"""
from __future__ import annotations

import logging
import re
from collections import defaultdict

from app.agents.base import BaseAgent, ProgressCallback
from app.agents.registry import AgentRegistry
from app.models.task import Task, StageStatus

logger = logging.getLogger(__name__)


@AgentRegistry.register
class SearchAgent(BaseAgent):
    name = "search"
    description = "API 数据源并行检索（文献 + 实体）"

    # 实体特定数据源：需用基因/化合物/疾病实体查询，而非研究目标
    ENTITY_SOURCES = {"string", "tcmsp", "disgenet", "pdb", "kegg", "drugbank"}

    async def execute(self, task: Task, records: list[dict],
                      context: dict,
                      progress: ProgressCallback | None = None) -> tuple[list[dict], dict]:
        self._set_stage(task, "search", StageStatus.RUNNING, "正在并行检索数据源...")
        self._emit(progress, type="stage_start", stage="search",
                    message="正在并行检索多个生物医学数据源...")

        sources = context.get("recommended_sources",
                              ["pubmed", "openalex", "semantic_scholar"])
        queries = context.get("search_queries", [task.research_goal])
        entities = context.get("entities", {})

        all_records: list[dict] = []
        prov = self.store.get_provenance(task.task_id)

        # 分组：文献数据源用研究目标查询；实体数据源用实体级查询
        lit_sources = [s for s in sources if s not in self.ENTITY_SOURCES]
        entity_sources = [s for s in sources if s in self.ENTITY_SOURCES]

        # Step 1: 文献数据源多查询并行检索
        # R1 修复：用 queries[:5] 而非 queries[0]，提升覆盖率 3-5 倍
        # R2 修复：max_results 从 task.max_sources(20) 提升到 max(..., 30)
        search_queries = [q for q in queries[:5] if q and q.strip()]
        if not search_queries:
            search_queries = [task.research_goal]
        max_results = max(task.max_sources, 30)

        self._emit(progress, type="stage_progress", stage="search",
                    pct=0.1, message=f"用 {len(search_queries)} 个查询并行检索 "
                                      f"{len(lit_sources)} 个文献数据源...")

        seen_record_ids: set[str] = set()
        per_query_pct = 0.4 / max(len(search_queries), 1)

        for q_idx, query in enumerate(search_queries):
            results = await self._to_thread(
                self.tools.run_datasources_parallel,
                lit_sources, query,
                max_results=max_results,
                task_id=task.task_id,
            )

            for i, (src_name, result) in enumerate(results.items()):
                pct = 0.1 + per_query_pct * q_idx + per_query_pct * (i + 1) / max(len(lit_sources), 1)
                if result.success:
                    new_recs = self._dedup_by_id(
                        self._extract_records(result), seen_record_ids)
                    all_records.extend(new_recs)
                    msg = f"✓ {src_name} [查询{q_idx+1}]: {len(new_recs)} 条"
                    if prov and new_recs:
                        rec_ids = [r.get("record_id", "") for r in new_recs]
                        prov.record("search", "search_agent", tool_name=src_name,
                                   output_records=rec_ids,
                                   parameters={"query": query, "source": src_name,
                                               "query_idx": q_idx})
                    if result.signals.get("status") == "requires_crawl":
                        context.setdefault("crawl_targets", []).append({
                            "source": src_name, "query": query,
                            "reason": result.signals.get("reason", ""),
                        })
                else:
                    msg = f"✗ {src_name} [查询{q_idx+1}]: {result.error[:50]}"
                    task.errors.append(f"{src_name}: {result.error}")

                self._emit(progress, type="stage_progress", stage="search",
                            pct=pct, message=msg)

        # Step 2: 实体数据源检索（用基因/化合物/疾病实体查询）
        if entity_sources:
            entity_queries = self._build_entity_queries(entities)
            self._emit(progress, type="stage_progress", stage="search",
                        pct=0.55,
                        message=f"检索 {len(entity_sources)} 个实体数据源"
                                f"（{len(entity_queries)} 个查询）...")
            entity_records = await self._search_entity_sources(
                entity_sources, entity_queries, task, prov, progress)
            all_records.extend(entity_records)

        # Step 3: 引用追溯（P1 — 系统综述式扩展）
        # 对高被引种子文献追溯参考文献/被引文献，扩展相关文献覆盖
        citation_records = await self._trace_citations(
            all_records, task, prov, progress)
        all_records.extend(citation_records)

        # Step 4: Darwinian Stage Gate（P2 — 智能 fallback：数量 + 相关性双维度）
        # 触发条件：记录数 < 10，或前 20 条采样相关性 < 0.3
        relevance = self._compute_relevance(all_records, task.research_goal, entities)
        need_fallback = len(all_records) < 10 or relevance < 0.3
        if need_fallback:
            gate_reason = (f"记录不足({len(all_records)}<10)"
                           if len(all_records) < 10
                           else f"相关性低({relevance:.0%}<30%)")
            await self._run_fallback(
                all_records, seen_record_ids, search_queries, queries,
                entities, lit_sources, max_results, task, prov, progress,
                gate_reason)

        # 多轮累积：取当前轮与历史轮的最大值，避免后续轮 0 条覆盖
        current_sources = len(set(
            r.get("source_ref", {}).get("source_name", "") for r in all_records
            if r.get("source_ref", {}).get("source_name", "")
        ))
        task.source_count = max(task.source_count, current_sources)
        msg = (f"检索完成：共 {len(all_records)} 条记录，"
               f"来自 {task.source_count} 个数据源")
        self._set_stage(task, "search", StageStatus.DONE, msg,
                        records_count=len(all_records))
        self._emit(progress, type="stage_complete", stage="search",
                    message=msg, records_count=len(all_records))
        self.store.update_task(task)
        return all_records, context

    def _build_entity_queries(self, entities: dict) -> list[dict]:
        """根据实体列表构造实体级查询。"""
        queries: list[dict] = []
        genes = entities.get("genes", [])
        compounds = entities.get("compounds", [])
        diseases = entities.get("diseases", [])

        for g in genes[:10]:
            queries.append({"source": "string", "query": g, "entity_type": "gene"})
            queries.append({"source": "disgenet", "query": g, "entity_type": "gene"})

        for c in compounds[:8]:
            queries.append({"source": "tcmsp", "query": c, "entity_type": "compound"})

        for d in diseases[:3]:
            d_en = self._disease_to_en(d)
            queries.append({"source": "disgenet", "query": d_en,
                            "entity_type": "disease", "mode": "disease"})
        return queries

    @staticmethod
    def _disease_to_en(disease: str) -> str:
        """常见中文疾病名转英文（DisGeNET/PubMed MeSH 需英文）。"""
        mapping = {
            "胰腺癌": "pancreatic cancer",
            "肝转移": "liver metastasis",
            "乳腺癌": "breast cancer",
            "肺癌": "lung cancer",
            "胃癌": "gastric cancer",
            "结直肠癌": "colorectal cancer",
            "肝癌": "liver cancer",
            "食管癌": "esophageal cancer",
            "前列腺癌": "prostate cancer",
            "白血病": "leukemia",
            "淋巴瘤": "lymphoma",
            "糖尿病": "diabetes",
            "高血压": "hypertension",
            "冠心病": "coronary heart disease",
            "动脉粥样硬化": "atherosclerosis",
            "阿尔茨海默病": "Alzheimer's disease",
            "帕金森病": "Parkinson's disease",
            "抑郁症": "depression",
            "炎症性肠病": "inflammatory bowel disease",
            "类风湿关节炎": "rheumatoid arthritis",
        }
        return mapping.get(disease, disease)

    async def _search_entity_sources(self, entity_sources: list[str],
                                      entity_queries: list[dict],
                                      task: Task, prov,
                                      progress: ProgressCallback | None) -> list[dict]:
        """检索实体特定数据源（string/tcmsp/disgenet 等）。"""
        all_records: list[dict] = []
        by_source: dict[str, list[dict]] = defaultdict(list)
        for q in entity_queries:
            if q["source"] in entity_sources:
                by_source[q["source"]].append(q)

        total = sum(len(qs) for qs in by_source.values())
        done = 0
        for src_name, qs in by_source.items():
            for q in qs:
                done += 1
                pct = 0.55 + 0.25 * done / max(total, 1)
                label = q["query"][:30]
                self._emit(progress, type="stage_progress", stage="search",
                            pct=pct,
                            message=f"{src_name}/{q.get('entity_type','')}: {label}")
                kwargs: dict = {}
                if src_name == "disgenet" and q.get("mode") == "disease":
                    kwargs["mode"] = "disease"
                result = await self._to_thread(
                    self.tools.run_datasource, src_name, q["query"],
                    min(task.max_sources, 10), task.task_id, **kwargs,
                )
                if result.success:
                    recs = self._extract_records(result)
                    all_records.extend(recs)
                    if prov and recs:
                        rec_ids = [r.get("record_id", "") for r in recs]
                        prov.record("search", "search_agent", tool_name=src_name,
                                   output_records=rec_ids,
                                   parameters={"query": q["query"], "source": src_name,
                                               "entity_type": q.get("entity_type", "")})
                    self._emit(progress, type="stage_progress", stage="search",
                                pct=pct,
                                message=f"✓ {src_name}/{label}: {len(recs)} 条")
                else:
                    msg = f"✗ {src_name}/{label}: {result.error[:50]}"
                    task.errors.append(f"{src_name}: {result.error}")
                    self._emit(progress, type="stage_progress", stage="search",
                                pct=pct, message=msg)
        return all_records

    # ========== 引用追溯（P1） ==========

    async def _trace_citations(self, records: list[dict], task: Task,
                                prov, progress: ProgressCallback | None,
                                top_n: int = 5) -> list[dict]:
        """对高被引种子文献追溯参考文献/被引文献。

        需 ≥3 篇含 openalex_id 的文献作为种子（否则跳过）。
        Returns:
            新文献记录列表（已按 record_id 去重，不含种子）
        """
        # 统计含 openalex_id 的记录数
        oa_records = [r for r in records
                      if r.get("fields", {}).get("openalex_id")]
        if len(oa_records) < 3:
            logger.info("引用追溯跳过：仅 %d 篇含 openalex_id（需≥3）",
                        len(oa_records))
            return []

        self._emit(progress, type="stage_progress", stage="search",
                    pct=0.7,
                    message=f"引用追溯中（top {top_n} 高被引文献的参考文献/被引）...")

        result = await self._to_thread(
            self.tools.trace_citations, records,
            max_results=15, task_id=task.task_id, direction="both",
        )
        if not result.success:
            task.errors.append(f"citation_trace: {result.error}")
            self._emit(progress, type="stage_progress", stage="search",
                        pct=0.75,
                        message=f"✗ 引用追溯失败: {result.error[:50]}")
            return []

        # 按已有 record_id 去重（种子记录已在 records 中）
        seen_ids = {r.get("record_id", "") for r in records}
        new_records = self._dedup_by_id(result.data or [], seen_ids)

        if new_records and prov:
            rec_ids = [r.get("record_id", "") for r in new_records]
            prov.record("search", "search_agent", tool_name="citation_trace",
                       output_records=rec_ids,
                       parameters={"direction": "both", "top_n": top_n,
                                   "seed_count": len(oa_records)})

        self._emit(progress, type="stage_progress", stage="search",
                    pct=0.75,
                    message=f"✓ 引用追溯: 新增 {len(new_records)} 条")
        return new_records

    # ========== 智能 fallback（P2 — 数量 + 相关性双维度） ==========

    def _compute_relevance(self, records: list[dict], research_goal: str,
                            entities: dict) -> float:
        """计算前 20 条记录与研究方向的相关性比率（0.0-1.0）。

        相关性 = 含至少一个关键词的采样记录数 / 采样总数
        关键词来源：research_goal 分词 + 实体（基因/化合物/疾病英文）
        """
        if not records:
            return 0.0

        # 构建关键词集合
        keywords = self._extract_keywords(research_goal)
        for g in entities.get("genes", []):
            keywords.add(g.lower())
        for c in entities.get("compounds", []):
            keywords.add(c.lower())
        for d in entities.get("diseases", []):
            keywords.add(self._disease_to_en(d).lower())
        if not keywords:
            return 1.0  # 无关键词可判，默认相关

        # 采样前 20 条，检查 title+abstract 是否含任一关键词
        sample = records[:20]
        matched = 0
        for r in sample:
            fields = r.get("fields", {})
            text = ((fields.get("title", "") or "") + " " +
                    (fields.get("abstract", "") or "")).lower()
            if any(kw in text for kw in keywords):
                matched += 1
        return matched / len(sample)

    @staticmethod
    def _extract_keywords(text: str) -> set[str]:
        """从文本中提取关键词（小写，长度≥3，过滤停用词）。"""
        if not text:
            return set()
        stopwords = {"the", "and", "for", "with", "from", "that", "this",
                     "are", "was", "were", "been", "have", "has", "study",
                     "research", "analysis", "using", "based", "through",
                     "的", "了", "在", "和", "与", "对", "及", "等", "中"}
        words = re.split(r"[\s,;:.\-()/]+", text)
        return {w.lower() for w in words
                if len(w) >= 3 and w.lower() not in stopwords}

    async def _run_fallback(self, all_records: list[dict],
                             seen_record_ids: set[str],
                             search_queries: list[str],
                             queries: list[str],
                             entities: dict, lit_sources: list[str],
                             max_results: int, task: Task, prov,
                             progress: ProgressCallback | None,
                             reason: str) -> None:
        """Darwinian Stage Gate fallback：组合查询 + MeSH + 未用 LLM 查询。

        就地扩展 all_records（list 可变）。
        """
        # 1. 收集 fallback 查询
        fallback_queries: list[str] = [
            q for q in queries[5:]
            if q and q.strip() and q not in search_queries
        ]
        combo_queries = self._build_combo_queries(entities)
        mesh_queries = self._build_mesh_queries(entities)

        self._emit(progress, type="stage_progress", stage="search",
                    pct=0.8,
                    message=f"扩展检索（{reason}）：{len(combo_queries)} 组合 + "
                            f"{len(mesh_queries)} MeSH + {len(fallback_queries)} LLM")

        retry_sources = [s for s in
                         ("pubmed", "europepmc", "openalex", "semantic_scholar", "arxiv")
                         if s in lit_sources or s not in self.ENTITY_SOURCES][:4]

        # 兜底：若 combo + fallback + mesh 全空（无 diseases 或 LLM 查询≤5），
        # 用实体名（基因/化合物，英文）作为查询，确保 fallback 不空转
        if not (combo_queries or fallback_queries or mesh_queries):
            genes = entities.get("genes", [])
            compounds = entities.get("compounds", [])
            combo_queries = [g for g in genes[:3]] + [c for c in compounds[:2]]
            logger.info("fallback 兜底：无 diseases/LLM 额外查询，用实体名检索 %s",
                        combo_queries)
            self._emit(progress, type="stage_progress", stage="search",
                        pct=0.82,
                        message=f"扩展检索兜底：用 {len(combo_queries)} 个实体名查询")

        # 2. 组合查询 + LLM 额外查询 → 全文献源
        seen_queries = set(search_queries)
        for q in (combo_queries + fallback_queries)[:6]:
            if not q or q in seen_queries:
                continue
            seen_queries.add(q)
            self._emit(progress, type="stage_progress", stage="search",
                        pct=0.85, message=f"扩展查询: {q[:40]}")
            await self._search_and_extend(
                retry_sources, q, min(max_results, 20),
                all_records, seen_record_ids, task, prov, progress,
                retry=True)

        # 3. MeSH 查询 → 仅 PubMed（MeSH 是 PubMed 特有字段）
        for q in mesh_queries:
            if q in seen_queries:
                continue
            seen_queries.add(q)
            self._emit(progress, type="stage_progress", stage="search",
                        pct=0.9, message=f"MeSH 查询(pubmed): {q[:40]}")
            await self._search_and_extend(
                ["pubmed"], q, min(max_results, 20),
                all_records, seen_record_ids, task, prov, progress,
                retry=True, mesh=True)

    async def _search_and_extend(self, sources: list[str], query: str,
                                   max_results: int,
                                   all_records: list[dict],
                                   seen_record_ids: set[str],
                                   task: Task, prov,
                                   progress: ProgressCallback | None,
                                   retry: bool = False,
                                   mesh: bool = False) -> None:
        """执行单次并行检索并就地扩展 all_records（去重 + 溯源 + 进度）。"""
        extra = await self._to_thread(
            self.tools.run_datasources_parallel,
            sources, query, max_results=max_results, task_id=task.task_id,
        )
        for src_name, result in extra.items():
            if not result.success:
                continue
            new_recs = self._dedup_by_id(
                self._extract_records(result), seen_record_ids)
            if not new_recs:
                continue
            all_records.extend(new_recs)
            if prov:
                rec_ids = [r.get("record_id", "") for r in new_recs]
                prov.record("search", "search_agent", tool_name=src_name,
                           output_records=rec_ids,
                           parameters={"query": query, "source": src_name,
                                       "retry": retry, "mesh": mesh})
            label = "MeSH" if mesh else ("扩展" if retry else "")
            self._emit(progress, type="stage_progress", stage="search",
                        pct=0.95,
                        message=f"✓ {src_name} ({label}): {len(new_recs)} 条")

    @staticmethod
    def _build_combo_queries(entities: dict) -> list[str]:
        """生成实体组合查询（P1 — gene×disease, compound×disease）。

        策略：
        - top 3 基因 × top 1 疾病 → "TP53 AND pancreatic cancer"
        - top 2 化合物 × top 1 疾病 → "curcumin AND pancreatic cancer"
        """
        queries: list[str] = []
        diseases = entities.get("diseases", [])
        genes = entities.get("genes", [])
        compounds = entities.get("compounds", [])
        if not diseases:
            return queries
        disease_en = SearchAgent._disease_to_en(diseases[0])

        for g in genes[:3]:
            queries.append(f"{g} AND {disease_en}")
        for c in compounds[:2]:
            queries.append(f"{c} AND {disease_en}")
        return queries

    @staticmethod
    def _build_mesh_queries(entities: dict) -> list[str]:
        """生成 MeSH 限定查询（P2 — PubMed MeSH Terms 精准检索）。

        PubMed 支持 term="{disease}"[MeSH] 语法，利用 MeSH 术语树精准匹配。
        """
        diseases = entities.get("diseases", [])
        if not diseases:
            return []
        disease_en = SearchAgent._disease_to_en(diseases[0])
        # "[MeSH] 限定 PubMed 仅检索 MeSH 术语匹配的文献
        return [f'{disease_en}[MeSH]']
