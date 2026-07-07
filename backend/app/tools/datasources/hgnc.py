"""HGNC 数据源插件。

通过 HGNC REST API 按基因符号或名称检索 HUGO 基因命名标准信息。
API 文档: https://www.genenames.org/help/rest/
"""
from __future__ import annotations

import logging
from typing import Any

from app.tools.datasources.base_ds import BaseDataSource, make_record

logger = logging.getLogger(__name__)


class HGNCSource(BaseDataSource):
    """HGNC 基因命名标准数据源。

    通过 HGNC REST API 按基因符号检索 HUGO 命名信息，
    包括：hgnc_id、基因符号、基因名称、locus_type、locus_group、
    status（Approved 等）、Ensembl/UniProt/NCBI 交叉引用、
    染色体位置与别名列表。
    """

    name: str = "hgnc"
    description: str = "HGNC 基因命名标准"
    base_url: str = "https://rest.genenames.org"
    default_rate: float = 1.0

    def search(
        self,
        query: str,
        max_results: int = 20,
        task_id: str = "default",
        **kwargs: Any,
    ) -> list[dict]:
        """检索 HGNC 基因记录。

        Args:
            query: 基因符号（如 TP53）或基因名称。
            max_results: 最多返回记录数。
            task_id: 关联任务 ID。
            **kwargs: 预留扩展参数。

        Returns:
            DataRecord 列表。
        """
        if not query or not query.strip():
            return []
        q = query.strip()
        url = f"{self.base_url}/search/{q}"
        params = {"search_type": "symbol"}
        headers = {"Accept": "application/json"}
        logger.debug("HGNC search: %s params=%s", url, params)
        data = self._get(url, params=params, headers=headers)
        if not isinstance(data, dict):
            return []
        response = data.get("response", {}) or {}
        if not isinstance(response, dict):
            return []
        docs = response.get("docs", []) or []
        records: list[dict] = []
        for doc in docs:
            if not isinstance(doc, dict):
                continue
            hgnc_id = doc.get("hgnc_id", "") or ""
            if not hgnc_id:
                continue

            uniprot_ids = doc.get("uniprot_ids", []) or []
            uniprot_id = ""
            if isinstance(uniprot_ids, list) and uniprot_ids:
                uniprot_id = uniprot_ids[0] or ""

            alias_symbol = doc.get("alias_symbol", []) or []
            aliases = (
                [a for a in alias_symbol if isinstance(a, str)]
                if isinstance(alias_symbol, list)
                else []
            )

            fields = {
                "hgnc_id": hgnc_id,
                "gene_symbol": doc.get("symbol", "") or "",
                "gene_name": doc.get("name", "") or "",
                "locus_type": doc.get("locus_type", "") or "",
                "locus_group": doc.get("locus_group", "") or "",
                "status": doc.get("status", "") or "",
                "ensembl_id": doc.get("ensembl_gene_id", "") or "",
                "uniprot_id": uniprot_id,
                "ncbi_gene_id": doc.get("entrez_id", "") or "",
                "chromosome": doc.get("location", "") or "",
                "aliases": aliases,
            }
            record = make_record(
                task_id=task_id,
                source_name=self.name,
                fields=fields,
                query=query,
                url=f"https://www.genenames.org/data/gene-symbol-report/#!/hgnc_id/{hgnc_id}",
                accession=hgnc_id,
                confidence=1.0,
                method="api",
            )
            records.append(record)
            if len(records) >= max_results:
                break
        return records
