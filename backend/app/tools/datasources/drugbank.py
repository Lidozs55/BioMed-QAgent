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
    BaseDataSource,
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


# ═══════════════════════════════════════════════════════════════════
# DrugBankSource — BaseDataSource 子类（dormant 路径，含预设数据降级）
# ═══════════════════════════════════════════════════════════════════

# 预设已知抗癌药物的靶点数据（文献来源）
_PRESET_DRUGS: dict[str, list[dict]] = {
    "imatinib": [
        {"target": "ABL1", "action": "inhibitor"},
        {"target": "KIT", "action": "inhibitor"},
        {"target": "PDGFRA", "action": "inhibitor"},
    ],
    "erlotinib": [
        {"target": "EGFR", "action": "inhibitor"},
    ],
    "cisplatin": [
        {"target": "DNA", "action": "crosslinker"},
    ],
    "doxorubicin": [
        {"target": "TOP2A", "action": "inhibitor"},
    ],
    "paclitaxel": [
        {"target": "TUBB1", "action": "stabilizer"},
    ],
    "rapamycin": [
        {"target": "MTOR", "action": "inhibitor"},
    ],
    "venetoclax": [
        {"target": "BCL2", "action": "inhibitor"},
    ],
    "olaparib": [
        {"target": "PARP1", "action": "inhibitor"},
    ],
    "trastuzumab": [
        {"target": "ERBB2", "action": "antibody"},
    ],
    "bevacizumab": [
        {"target": "VEGFA", "action": "antibody"},
    ],
}

_PRESET_TARGETS: dict[str, list[str]] = {
    "EGFR": ["erlotinib", "gefitinib", "osimertinib", "cetuximab"],
    "BCR-ABL1": ["imatinib", "dasatinib", "nilotinib"],
    "BRAF": ["vemurafenib", "dabrafenib"],
    "MTOR": ["rapamycin", "everolimus", "temsirolimus"],
    "BCL2": ["venetoclax", "navitoclax"],
    "PARP1": ["olaparib", "niraparib", "rucaparib"],
    "ERBB2": ["trastuzumab", "pertuzumab", "lapatinib"],
    "VEGFA": ["bevacizumab", "ranibizumab"],
    "ALK": ["crizotinib", "alectinib", "ceritinib"],
    "ABL1": ["imatinib", "dasatinib", "nilotinib", "ponatinib"],
}


class DrugBankSource(BaseDataSource):
    """DrugBank 药物-靶点-疾病关联数据源（受控访问）。

    支持两种检索模式：
    - drug:  按药物名查询靶点和作用机制
    - target: 按基因符号查询已知靶向药物

    DrugBank API 需要 API key。无 API key 时使用预设数据库。
    """

    name: str = "drugbank"
    description: str = "DrugBank drug-target-disease associations (controlled access)"
    base_url: str = "https://go.drugbank.com/api/v1/"
    default_rate: float = 1.0

    def search(
        self,
        query: str,
        max_results: int = 20,
        task_id: str = "default",
        **kwargs,
    ) -> list[dict]:
        if not query or not query.strip():
            return []
        mode = kwargs.get("mode", "drug")
        api_key = kwargs.get("api_key", "")
        q = query.strip()

        if mode == "target":
            return self._search_target(q, max_results, task_id, api_key)
        return self._search_drug(q, max_results, task_id, api_key)

    # ── drug 模式 ──

    def _search_drug(self, query: str, max_results: int, task_id: str,
                     api_key: str = "") -> list[dict]:
        drug_lower = query.strip().lower()

        if api_key:
            try:
                url = f"{self.base_url}drugs/search"
                data = self._get(url, params={"q": query, "limit": max_results})
                if isinstance(data, dict) and data.get("hits"):
                    records: list[dict] = []
                    for item in data["hits"]:
                        if not isinstance(item, dict):
                            continue
                        drug_name = item.get("name", drug_lower)
                        targets = item.get("targets", []) or []
                        for t in targets[:max_results]:
                            fields = {
                                "drug_name": drug_name,
                                "target": t.get("name", ""),
                                "action": t.get("action", ""),
                                "source_database": "DrugBank",
                            }
                            rec = make_record(
                                task_id=task_id, source_name=self.name,
                                fields=fields, query=query,
                                url=f"https://go.drugbank.com/drugs/{item.get('drugbank_id', '')}",
                                accession=item.get("drugbank_id", ""),
                                confidence=0.85, method="api",
                            )
                            records.append(rec)
                            if len(records) >= max_results:
                                break
                        if len(records) >= max_results:
                            break
                    if records:
                        return records
            except Exception as e:
                logger.debug("drugbank: DrugBank API 不可用: %s", e)

        return self._lookup_preset_drugs(drug_lower, max_results, task_id)

    def _lookup_preset_drugs(self, drug: str, max_results: int,
                             task_id: str) -> list[dict]:
        targets = _PRESET_DRUGS.get(drug, [])
        if not targets:
            for known in _PRESET_DRUGS:
                if known in drug or drug in known:
                    targets = _PRESET_DRUGS[known]
                    break
        if not targets:
            logger.info("drugbank: drug %s 无预设靶点数据", drug)
            return []

        records: list[dict] = []
        for t in targets:
            fields = {
                "drug_name": drug,
                "target": t["target"],
                "action": t["action"],
                "source_database": "DrugBank (preset)",
            }
            rec = make_record(
                task_id=task_id, source_name=self.name,
                fields=fields, query=drug,
                url=f"https://go.drugbank.com/drugs/{drug}",
                accession=drug, confidence=0.80, method="preset",
            )
            records.append(rec)
            if len(records) >= max_results:
                break
        return records

    # ── target 模式 ──

    def _search_target(self, query: str, max_results: int, task_id: str,
                       api_key: str = "") -> list[dict]:
        gene = query.strip().upper()

        if api_key:
            try:
                url = f"{self.base_url}targets/search"
                data = self._get(url, params={"q": gene, "limit": max_results})
                if isinstance(data, dict) and data.get("hits"):
                    records: list[dict] = []
                    for item in data["hits"]:
                        if not isinstance(item, dict):
                            continue
                        for drug_info in (item.get("drugs", []) or [])[:max_results]:
                            fields = {
                                "gene_symbol": gene,
                                "drug_name": drug_info.get("name", ""),
                                "action": drug_info.get("action", ""),
                                "source_database": "DrugBank",
                            }
                            rec = make_record(
                                task_id=task_id, source_name=self.name,
                                fields=fields, query=query,
                                url=f"https://go.drugbank.com/targets/{gene}",
                                accession=gene, confidence=0.85, method="api",
                            )
                            records.append(rec)
                            if len(records) >= max_results:
                                break
                        if len(records) >= max_results:
                            break
                    if records:
                        return records
            except Exception as e:
                logger.debug("drugbank: target API 不可用: %s", e)

        return self._lookup_preset_targets(gene, max_results, task_id)

    def _lookup_preset_targets(self, gene: str, max_results: int,
                                task_id: str) -> list[dict]:
        drugs = _PRESET_TARGETS.get(gene, [])
        if not drugs:
            logger.info("drugbank: target %s 无预设药物数据", gene)
            return []

        records: list[dict] = []
        for drug in drugs:
            fields = {
                "gene_symbol": gene,
                "drug_name": drug,
                "source_database": "DrugBank (preset)",
            }
            rec = make_record(
                task_id=task_id, source_name=self.name,
                fields=fields, query=gene,
                url=f"https://go.drugbank.com/targets/{gene}",
                accession=gene, confidence=0.75, method="preset",
            )
            records.append(rec)
            if len(records) >= max_results:
                break
        return records
