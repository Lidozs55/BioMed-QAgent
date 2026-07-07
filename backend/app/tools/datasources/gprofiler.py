"""g:Profiler 数据源插件。

通过 g:Profiler gost API 进行 GO/KEGG/Reactome 等功能富集分析。
API: https://biit.cs.ut.ee/gprofiler/api/gost/profile/
限速: 1 req/sec（无需 API key）
"""
from __future__ import annotations

import logging
from typing import Any

from app.tools.datasources.base_ds import BaseDataSource, make_record

logger = logging.getLogger(__name__)


class GProfilerSource(BaseDataSource):
    """g:Profiler 数据源。

    接受逗号分隔的基因符号字符串（如 "TP53,AKT1,EGFR"）或单个基因，
    调用 g:Profiler gost/profile API 进行功能富集分析，返回显著富集的
    GO/KEGG/Reactome 等 term 列表。
    """

    name = "gprofiler"
    description = "g:Profiler GO/KEGG/Reactome 富集分析"
    base_url = "https://biit.cs.ut.ee/gprofiler/api/gost/profile/"
    default_rate = 1.0

    _SOURCES = ["GO:BP", "GO:MF", "GO:CC", "KEGG", "REAC", "TF", "MIRNA", "HP", "HPA", "WP"]

    def search(self, query: str, max_results: int = 20,
               task_id: str = "default", **kwargs) -> list[dict]:
        """执行富集分析，返回 DataRecord 列表。

        Args:
            query: 基因符号字符串，逗号分隔（如 "TP53,AKT1,EGFR"）或单个基因。
            max_results: 返回记录数上限。
            task_id: 任务标识。

        Keyword Args:
            organism: 物种，默认 "hsapiens"。
            sources: 数据源列表，默认 GO/KEGG/REAC 等全集。
            user_threshold: 显著性阈值，默认 0.05。
        """
        if not query or not query.strip():
            logger.warning("gprofiler: 空 query")
            return []

        organism = kwargs.get("organism", "hsapiens")
        sources = kwargs.get("sources", self._SOURCES)
        user_threshold = kwargs.get("user_threshold", 0.05)

        body = {
            "organism": organism,
            "query": query,
            "significance_threshold_method": "g_SCS",
            "user_threshold": user_threshold,
            "sources": sources,
            "domain_size": "annotated",
            "no_evidences": False,
        }

        try:
            payload = self._post(self.base_url, body)
        except Exception as e:
            logger.error("gprofiler: 请求失败: %s", e)
            return []

        if not isinstance(payload, dict):
            logger.warning("gprofiler: 响应非 dict: %r", type(payload))
            return []

        results = payload.get("result", []) or []
        records: list[dict] = []
        for item in results:
            if not isinstance(item, dict):
                continue
            rec = self._build_record(item, query, task_id)
            if rec is not None:
                records.append(rec)
            if len(records) >= max_results:
                break
        return records

    def _build_record(self, item: dict, query: str, task_id: str) -> dict | None:
        """从单条 g:Profiler 结果构造 DataRecord。"""
        term_id = item.get("native", "") or ""
        if not term_id:
            return None

        term_name = item.get("name", "") or ""
        term_source = item.get("source", "") or ""
        intersection_genes = self._extract_genes(item)

        fields: dict[str, Any] = {
            "term_id": term_id,
            "term_name": term_name,
            "term_source": term_source,
            "p_value": item.get("p_value"),
            "fdr": item.get("fdr"),
            "precision": item.get("precision"),
            "recall": item.get("recall"),
            "intersection_size": item.get("intersection_size"),
            "term_size": item.get("term_size"),
            "query_size": item.get("query_size"),
            "intersection_genes": intersection_genes,
        }

        url = self._build_url(term_id, term_source)
        return make_record(
            task_id, "gprofiler", fields, query,
            url=url, accession=term_id, confidence=0.9,
        )

    @staticmethod
    def _build_url(term_id: str, term_source: str) -> str:
        """根据 term_source 选择合适的 URL。

        GO term（source 以 "GO" 开头）用 QuickGO，其余用 g:Profiler gost 页面。
        """
        if term_source.startswith("GO"):
            return f"https://www.ebi.ac.uk/QuickGO/term/{term_id}"
        return f"https://biit.cs.ut.ee/gprofiler/gost?term={term_id}"

    @staticmethod
    def _extract_genes(item: dict) -> list[str]:
        """从 evidences 提取 gene_symbols，回退到 intersections。

        evidences 结构（no_evidences=false 时返回）:
            [{"genes": [{"gene_symbol": "TP53", ...}, ...]}, ...]
        intersections 结构（按查询分组的基因符号）:
            [["TP53", "AKT1"], ...]
        """
        genes: list[str] = []
        seen: set[str] = set()

        evidences = item.get("evidences") or []
        if isinstance(evidences, list):
            for ev in evidences:
                if not isinstance(ev, dict):
                    continue
                ev_genes = ev.get("genes") or []
                if not isinstance(ev_genes, list):
                    continue
                for g in ev_genes:
                    if not isinstance(g, dict):
                        continue
                    sym = g.get("gene_symbol") or ""
                    if sym and sym not in seen:
                        seen.add(sym)
                        genes.append(sym)
        if genes:
            return genes

        # 回退：intersections 是按查询分组的基因符号列表
        intersections = item.get("intersections") or []
        if isinstance(intersections, list):
            for group in intersections:
                if isinstance(group, list):
                    for sym in group:
                        if isinstance(sym, str) and sym and sym not in seen:
                            seen.add(sym)
                            genes.append(sym)
        return genes
