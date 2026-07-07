"""cBioPortal 数据源插件。

通过 cBioPortal REST API v2 检索癌症基因组队列数据。
API 文档: https://www.cbioportal.org/api
支持 studies / genes / clinical 三种检索模式。
"""
from __future__ import annotations

import logging
from typing import Any

from app.tools.datasources.base_ds import BaseDataSource, make_record

logger = logging.getLogger(__name__)


class CBioPortalSource(BaseDataSource):
    """cBioPortal 癌症基因组队列数据源。

    通过 cBioPortal REST API v2 检索：
    - studies 模式：按关键词查询研究（cancer type、citation、pmid 等）
    - genes 模式：按基因符号查询基因信息（entrez id、cytoband 等）
    - clinical 模式：查询某研究的临床数据（sample-level clinical attributes）
    """

    name: str = "cbioportal"
    description: str = "cBioPortal 癌症基因组队列"
    base_url: str = "https://www.cbioportal.org/api"
    default_rate: float = 1.0

    # cBioPortal API 要求 Accept: application/json
    _JSON_HEADERS = {"Accept": "application/json"}

    def search(self, query: str, max_results: int = 20,
               task_id: str = "default", **kwargs) -> list[dict]:
        """执行 cBioPortal 检索。

        Args:
            query: 检索关键词。
                - studies 模式：研究关键词（如 "breast cancer"）
                - genes 模式：基因符号（如 "TP53"）
                - clinical 模式：studyId（如 "brca_tcga"）
            max_results: 最多返回记录数。
            task_id: 关联任务 ID。
            **kwargs:
                mode: studies / genes / clinical，默认 studies

        Returns:
            DataRecord 列表。
        """
        if not query or not query.strip():
            return []
        mode = kwargs.get("mode", "studies")
        if mode == "genes":
            return self._search_genes(query, max_results, task_id)
        if mode == "clinical":
            return self._search_clinical(query, max_results, task_id)
        if mode != "studies":
            logger.warning("cBioPortal 未知 mode: %s, 回退到 studies", mode)
        return self._search_studies(query, max_results, task_id)

    # ---- 各模式实现 ----

    def _search_studies(self, query: str, max_results: int,
                        task_id: str) -> list[dict]:
        """按关键词查询研究。"""
        url = f"{self.base_url}/studies"
        params = {
            "keyword": query,
            "pageSize": max_results,
            "direction": "ASC",
        }
        data = self._get(url, params=params, headers=self._JSON_HEADERS)
        items = self._as_list(data)
        records: list[dict] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            study_id = item.get("studyId") or ""
            if not study_id:
                continue
            fields: dict[str, Any] = {
                "study_id": study_id,
                "name": item.get("name"),
                "description": item.get("description"),
                "cancer_type": item.get("cancerType"),
                "cancer_type_detailed": item.get("cancerTypeDetailed"),
                "pmid": item.get("pmid"),
                "citation": item.get("citation"),
                "groups": item.get("groups"),
                "status": item.get("status"),
                "import_date": item.get("importDate"),
            }
            records.append(make_record(
                task_id=task_id,
                source_name=self.name,
                fields=fields,
                query=query,
                url=f"https://www.cbioportal.org/study/summary?id={study_id}",
                accession=study_id,
                confidence=0.95,
            ))
        return records

    def _search_genes(self, query: str, max_results: int,
                      task_id: str) -> list[dict]:
        """按基因符号查询基因信息。"""
        url = f"{self.base_url}/genes"
        params = {
            "keyword": query,
            "pageSize": max_results,
        }
        data = self._get(url, params=params, headers=self._JSON_HEADERS)
        items = self._as_list(data)
        records: list[dict] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            gene_id = item.get("entrezGeneId")
            gene_symbol = item.get("hugoGeneSymbol") or ""
            if gene_id is None and not gene_symbol:
                continue
            fields: dict[str, Any] = {
                "gene_id": gene_id,
                "gene_symbol": gene_symbol,
                "gene_type": item.get("type"),
                "cytoband": item.get("cytoband"),
                "length": item.get("length"),
            }
            records.append(make_record(
                task_id=task_id,
                source_name=self.name,
                fields=fields,
                query=query,
                url=f"https://www.cbioportal.org/gene/{gene_symbol}",
                accession=str(gene_id) if gene_id is not None else gene_symbol,
                confidence=1.0,
            ))
        return records

    def _search_clinical(self, query: str, max_results: int,
                         task_id: str) -> list[dict]:
        """查询某研究的临床数据。query 为 studyId。"""
        study_id = query.strip()
        url = f"{self.base_url}/studies/{study_id}/clinical-data"
        params = {"pageSize": max_results}
        data = self._get(url, params=params, headers=self._JSON_HEADERS)
        items = self._as_list(data)
        records: list[dict] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            sample_id = item.get("sampleId") or ""
            clinical_attribute = item.get("clinicalAttributeId") or ""
            value = item.get("value")
            if not sample_id and not clinical_attribute:
                continue
            fields: dict[str, Any] = {
                "sample_id": sample_id,
                "clinical_attribute": clinical_attribute,
                "value": value,
            }
            records.append(make_record(
                task_id=task_id,
                source_name=self.name,
                fields=fields,
                query=query,
                url=f"https://www.cbioportal.org/study/summary?id={study_id}",
                accession=study_id,
                confidence=0.9,
            ))
        return records

    # ---- 辅助方法 ----

    @staticmethod
    def _as_list(data: Any) -> list[dict]:
        """cBioPortal API 返回 JSON 数组，安全转为列表。"""
        if isinstance(data, list):
            return data
        return []
