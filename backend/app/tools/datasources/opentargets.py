"""OpenTargets Platform 数据源插件。

通过 GraphQL API 检索靶点-疾病关联与药物信息。
API: https://api.platform.opentargets.org/api/v4/graphql
限速: 1 req/sec（无需 API key）
"""
from __future__ import annotations

import logging
from typing import Any

from app.tools.datasources.base_ds import BaseDataSource, make_record

logger = logging.getLogger(__name__)


class OpenTargetsSource(BaseDataSource):
    """OpenTargets Platform 数据源。

    支持两种检索模式：
    - target: 按基因符号查询关联疾病（先 search 取 ensemblId，再查 associatedDiseases）
    - drug: 按药物名称查询药物信息
    """

    name = "opentargets"
    description = "OpenTargets 靶点-疾病-药物证据"
    base_url = "https://api.platform.opentargets.org/api/v4/graphql"
    default_rate = 1.0

    # 先按基因符号检索 target，获取 ensemblId
    _TARGET_SEARCH_QUERY = """
    query Search($q: String!, $size: Int!) {
      search(queryString: $q, entityNames: ["target"], page: {index: 0, size: $size}) {
        hits { id name entity description score }
      }
    }
    """

    # 按 ensemblId 查询 target 的关联疾病
    _TARGET_ASSOCIATIONS_QUERY = """
    query TargetAssociations($ensemblId: String!, $size: Int!) {
      target(ensemblId: $ensemblId) {
        id
        approvedSymbol
        approvedName
        associatedDiseases(page: {index: 0, size: $size}) {
          rows { score disease { id name } }
        }
      }
    }
    """

    # 按药物名称检索
    _DRUG_SEARCH_QUERY = """
    query Search($q: String!, $size: Int!) {
      search(queryString: $q, entityNames: ["drug"], page: {index: 0, size: $size}) {
        hits { id name entity description score }
      }
    }
    """

    def _graphql(self, query: str, variables: dict[str, Any]) -> dict:
        """执行 GraphQL POST 请求，处理 errors 字段并返回 data。"""
        payload = self._post(self.base_url, {"query": query, "variables": variables})
        if not isinstance(payload, dict):
            return {}
        if payload.get("errors"):
            raise RuntimeError(f"OpenTargets GraphQL 错误: {payload['errors']}")
        return payload.get("data", {}) or {}

    def search(self, query: str, max_results: int = 20,
               task_id: str = "default", **kwargs) -> list[dict]:
        """执行检索，返回 DataRecord 列表。

        kwargs:
            mode: 检索模式，"target"（默认）或 "drug"
        """
        mode = kwargs.get("mode", "target")
        if mode == "drug":
            return self._search_drug(query, max_results, task_id)
        return self._search_target(query, max_results, task_id)

    def _search_target(self, query: str, max_results: int, task_id: str) -> list[dict]:
        """target 模式：按基因符号查询关联疾病。"""
        # 1. 先用 search 查询 target，取第一个结果的 ensemblId
        data = self._graphql(self._TARGET_SEARCH_QUERY, {"q": query, "size": 1})
        hits = (data.get("search", {}) or {}).get("hits", []) or []
        if not hits:
            logger.warning("opentargets: 未找到 target %s", query)
            return []
        first = hits[0] if isinstance(hits[0], dict) else {}
        ensembl_id = first.get("id", "") or ""
        if not ensembl_id:
            logger.warning("opentargets: target %s 无 ensemblId", query)
            return []

        # 2. 查询 associatedDiseases
        tdata = self._graphql(
            self._TARGET_ASSOCIATIONS_QUERY,
            {"ensemblId": ensembl_id, "size": max_results},
        )
        target = tdata.get("target", {}) or {}
        if not target:
            logger.warning("opentargets: ensemblId %s 无 target 数据", ensembl_id)
            return []

        gene_symbol = target.get("approvedSymbol", "") or query
        gene_id = target.get("id", "") or ensembl_id
        target_name = target.get("approvedName", "") or ""
        url = f"https://platform.opentargets.org/target/{gene_id}"

        rows = (target.get("associatedDiseases", {}) or {}).get("rows", []) or []
        records: list[dict] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            disease = row.get("disease", {}) or {}
            fields = {
                "gene_symbol": gene_symbol,
                "gene_id": gene_id,
                "disease": disease.get("name", "") or "",
                "disease_id": disease.get("id", "") or "",
                "score": row.get("score", 0.0),
                "target_name": target_name,
            }
            rec = make_record(
                task_id, "opentargets", fields, query,
                url=url, accession=gene_id or None, confidence=0.9,
            )
            records.append(rec)
            if len(records) >= max_results:
                break
        return records

    def _search_drug(self, query: str, max_results: int, task_id: str) -> list[dict]:
        """drug 模式：按药物名称查询。"""
        data = self._graphql(self._DRUG_SEARCH_QUERY, {"q": query, "size": max_results})
        hits = (data.get("search", {}) or {}).get("hits", []) or []
        records: list[dict] = []
        for hit in hits:
            if not isinstance(hit, dict):
                continue
            drug_id = hit.get("id", "") or ""
            drug_name = hit.get("name", "") or ""
            fields = {
                "drug_name": drug_name,
                "compound_name": drug_name,
                "drug_id": drug_id,
                "description": hit.get("description", "") or "",
                "score": hit.get("score", 0.0),
            }
            url = f"https://platform.opentargets.org/drug/{drug_id}" if drug_id else None
            rec = make_record(
                task_id, "opentargets", fields, query,
                url=url, accession=drug_id or None, confidence=0.9,
            )
            records.append(rec)
        return records
