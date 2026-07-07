"""Search Agent — API 数据源并行检索。

从 Orchestrator._stage_search 迁入，职责：
- 文献数据源用研究目标并行检索
- 实体数据源用基因/化合物/疾病实体检索
- Darwinian Stage Gate：记录不足时用扩展查询重试
- 收集 requires_crawl 信号供 AcquireAgent 使用
"""
from __future__ import annotations

import logging
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
                recs = (result.data if isinstance(result.data, list)
                        else ([result.data] if result.data else []))
                all_records.extend(recs)
                msg = f"✓ {src_name}: {len(recs)} 条记录"
                if prov and recs:
                    rec_ids = [r.get("record_id", "") for r in recs]
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
                        pct=0.55,
                        message=f"检索 {len(entity_sources)} 个实体数据源"
                                f"（{len(entity_queries)} 个查询）...")
            entity_records = await self._search_entity_sources(
                entity_sources, entity_queries, task, prov, progress)
            all_records.extend(entity_records)

        # Darwinian Stage Gate: 记录不足时用更宽泛的查询重试
        if len(all_records) < 5:
            fallback_queries: list[str] = [q for q in queries[1:]
                                            if q and q != primary_query]
            diseases = entities.get("diseases", [])
            genes = entities.get("genes", [])
            if diseases:
                fallback_queries.append(f"{diseases[0]} liver metastasis")
            if genes:
                fallback_queries.append(f"{' '.join(genes[:3])} pancreatic cancer")
            fallback_queries.append("pancreatic cancer liver metastasis")
            fallback_queries.append("TCM pancreatic cancer metastasis")

            retry_sources = [s for s in
                             ("pubmed", "openalex", "semantic_scholar", "arxiv")][:4]

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
                        recs = (result.data if isinstance(result.data, list)
                                else ([result.data] if result.data else []))
                        all_records.extend(recs)
                        if recs and prov:
                            rec_ids = [r.get("record_id", "") for r in recs]
                            prov.record("search", "search_agent", tool_name=src_name,
                                       output_records=rec_ids,
                                       parameters={"query": q, "source": src_name,
                                                   "retry": True})
                            self._emit(progress, type="stage_progress", stage="search",
                                        pct=0.95,
                                        message=f"✓ {src_name} (扩展): {len(recs)} 条")

        task.source_count = len(set(
            r.get("source_ref", {}).get("source_name", "") for r in all_records
        ))
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
                    recs = (result.data if isinstance(result.data, list)
                            else ([result.data] if result.data else []))
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
