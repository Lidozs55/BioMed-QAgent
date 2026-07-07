"""DrugBank 药物-靶点互作检索客户端。

DrugBank Open Data 完整数据需下载 XML，本模块采用 OpenTargets Platform API（无需 API key）
作为替代，检索药物及其作用机制与靶点。

API: OpenTargets Platform GraphQL API
端点: https://api.platform.opentargets.org/api/v4/graphql
限速: 1 req/sec

若 OpenTargets 不可用，抛出异常。

用法:
    from app.tools.datasources.drugbank import search_drugbank
    records = search_drugbank("aspirin", max_results=20, task_id="task1")
"""
from __future__ import annotations

import logging

try:
    import requests
except ImportError:  # pragma: no cover - 优雅降级
    requests = None  # type: ignore[assignment]

from .base_ds import (
    DRUGBANK_URL,
    RateLimiter,
    make_record,
)

logger = logging.getLogger(__name__)

HEADERS = {"User-Agent": "BioMedQAgent/1.0", "Content-Type": "application/json"}

SEARCH_QUERY = """
query Search($q: String!, $size: Int!) {
  search(queryString: $q, entityNames: ["drug"], page: {index: 0, size: $size}) {
    total
    hits {
      id
      name
      entity
      description
      score
    }
  }
}
"""

MECHANISM_QUERY = """
query Mechanisms($drugId: String!) {
  drug(id: $drugId) {
    id
    name
    ... on Drug {
      mechanismsOfAction {
        rows {
          mechanismOfAction
          target {
            approvedSymbol
          }
        }
      }
    }
  }
}
"""


def _post(query: str, variables: dict, limiter: RateLimiter) -> dict:
    limiter.wait()
    r = requests.post(
        DRUGBANK_URL, json={"query": query, "variables": variables},
        headers=HEADERS, timeout=60,
    )
    r.raise_for_status()
    payload = r.json()
    if payload.get("errors"):
        raise RuntimeError(f"GraphQL 错误: {payload['errors']}")
    return payload.get("data", {}) or {}


def search_drugbank(query: str, max_results: int, task_id: str) -> list[dict]:
    limiter = RateLimiter(1.0)
    # 1. 检索药物
    data = _post(SEARCH_QUERY, {"q": query, "size": max_results}, limiter)
    hits = (data.get("search", {}) or {}).get("hits", []) or []
    records = []
    for hit in hits:
        if not isinstance(hit, dict):
            continue
        drug_id = hit.get("id", "") or ""
        drug_name = hit.get("name", "") or ""
        # 2. 获取作用机制与靶点（best-effort，失败则留空）
        target_protein = ""
        gene_symbol = ""
        mechanism_of_action = ""
        if drug_id:
            try:
                ddata = _post(MECHANISM_QUERY, {"drugId": drug_id}, limiter)
                drug = ddata.get("drug", {}) or {}
                rows = (drug.get("mechanismsOfAction", {}) or {}).get("rows", []) or []
                if rows:
                    first_row = rows[0] if isinstance(rows[0], dict) else {}
                    mechanism_of_action = first_row.get("mechanismOfAction", "") or ""
                    tgt = first_row.get("target", {}) or {}
                    gene_symbol = tgt.get("approvedSymbol", "") or ""
                    target_protein = gene_symbol
            except Exception as e:
                logger.warning("drugbank: 获取 %s 机制失败: %s", drug_id, e)
        fields = {
            "drug_name": drug_name,
            "compound_name": drug_name,
            "drug_id": drug_id,
            "target_protein": target_protein,
            "gene_symbol": gene_symbol,
            "mechanism_of_action": mechanism_of_action,
            "indication": hit.get("description", "") or "",
            "smiles": "",
        }
        url = f"https://platform.opentargets.org/drug/{drug_id}" if drug_id else None
        rec = make_record(
            task_id, "drugbank", fields, query,
            url=url, accession=drug_id or None, confidence=0.85,
        )
        records.append(rec)
    return records
