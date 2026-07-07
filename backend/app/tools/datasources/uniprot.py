"""UniProt 数据源插件。

通过 UniProt REST API 检索蛋白序列与功能注释。
API 文档: https://www.uniprot.org/help/api
"""
from __future__ import annotations

import logging
from typing import Any

from app.tools.datasources.base_ds import BaseDataSource, make_record

logger = logging.getLogger(__name__)


class UniProtSource(BaseDataSource):
    """UniProt 蛋白序列与注释数据源。

    通过 UniProt REST API 按基因符号或蛋白名称检索蛋白信息，
    包括：uniprot_id、蛋白名、基因符号、物种、序列长度、
    功能注释、亚细胞定位等。
    """

    name: str = "uniprot"
    description: str = "UniProt 蛋白序列与注释"
    base_url: str = "https://rest.uniprot.org"
    default_rate: float = 1.0

    def _build_query(self, query: str) -> str:
        """构造 UniProt 检索表达式，同时匹配基因符号与蛋白名称。"""
        q = f'"{query}"' if " " in query else query
        return f"gene:{q} OR name:{q}"

    def _extract_function(self, comments: list[dict] | None) -> str:
        """从 comments 中提取 FUNCTION 注释文本。"""
        if not comments:
            return ""
        for c in comments:
            if not isinstance(c, dict):
                continue
            ct = c.get("commentType") or c.get("type", "")
            if ct == "FUNCTION":
                texts = c.get("texts")
                if texts is None:
                    texts = c.get("text", [])
                if isinstance(texts, list):
                    values = [
                        t.get("value", "") for t in texts if isinstance(t, dict)
                    ]
                    return " ".join(v for v in values if v)
                if isinstance(texts, dict):
                    return texts.get("value", "")
                if isinstance(texts, str):
                    return texts
        return ""

    def _extract_subcellular_location(
        self, comments: list[dict] | None
    ) -> str:
        """从 comments 中提取 SUBCELLULAR LOCATION 注释。"""
        if not comments:
            return ""
        for c in comments:
            if not isinstance(c, dict):
                continue
            ct = c.get("commentType") or c.get("type", "")
            if ct == "SUBCELLULAR LOCATION":
                locs = c.get("subcellularLocations") or []
                if locs and isinstance(locs, list):
                    first = locs[0] if isinstance(locs[0], dict) else {}
                    location = first.get("location", {}) or {}
                    return location.get("value", "") or ""
        return ""

    def search(
        self,
        query: str,
        max_results: int = 20,
        task_id: str = "default",
        **kwargs: Any,
    ) -> list[dict]:
        """检索 UniProt 蛋白记录。

        Args:
            query: 基因符号（如 TP53）或蛋白名称。
            max_results: 最多返回记录数。
            task_id: 关联任务 ID。
            **kwargs: 预留扩展参数。

        Returns:
            DataRecord 列表。
        """
        if not query or not query.strip():
            return []
        search_query = self._build_query(query.strip())
        params = {
            "query": search_query,
            "format": "json",
            "size": max_results,
        }
        url = f"{self.base_url}/uniprotkb/search"
        logger.debug("UniProt search: %s params=%s", url, params)
        data = self._get(url, params=params)
        if not isinstance(data, dict):
            return []
        results = data.get("results", []) or []
        records: list[dict] = []
        for entry in results:
            if not isinstance(entry, dict):
                continue
            uniprot_id = entry.get("primaryAccession", "") or ""
            if not uniprot_id:
                continue

            protein_desc = entry.get("proteinDescription", {}) or {}
            rec_name = protein_desc.get("recommendedName", {}) or {}
            full_name = rec_name.get("fullName", {}) or {}
            protein_name = full_name.get("value", "") or ""

            genes = entry.get("genes", []) or []
            gene_symbol = ""
            if genes and isinstance(genes, list):
                first_gene = genes[0] if isinstance(genes[0], dict) else {}
                gene_name = first_gene.get("geneName", {}) or {}
                gene_symbol = gene_name.get("value", "") or ""

            organism = entry.get("organism", {}) or {}
            organism_name = organism.get("scientificName", "") or ""

            sequence = entry.get("sequence", {}) or {}
            sequence_length = sequence.get("length", 0) or 0

            comments = entry.get("comments", []) or []
            function_text = self._extract_function(comments)
            subcell = self._extract_subcellular_location(comments)

            fields = {
                "uniprot_id": uniprot_id,
                "protein_name": protein_name,
                "gene_symbol": gene_symbol,
                "organism": organism_name,
                "sequence_length": sequence_length,
                "function": function_text,
                "subcellular_location": subcell,
            }
            record = make_record(
                task_id=task_id,
                source_name=self.name,
                fields=fields,
                query=query,
                url=f"https://www.uniprot.org/uniprot/{uniprot_id}",
                accession=uniprot_id,
                confidence=1.0,
                method="api",
            )
            records.append(record)
        return records
