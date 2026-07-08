"""DisGeNET 基因-疾病关联检索客户端。

API: DisGeNET REST API
端点: https://www.disgenet.org/api/gda
限速: 1 req/sec
认证: 需要 API key，从环境变量 DISGENET_API_KEY 读取

检索模式:
  - gene:    按基因 symbol 检索关联疾病（geneId2disease）
  - disease: 按疾病名称/CUI 检索关联基因（disease2geneId）

用法:
    from app.tools.datasources.disgenet import search_disgenet
    records = search_disgenet("TP53", mode="gene", max_results=20, task_id="task1")
    records = search_disgenet("Breast Cancer", mode="disease", max_results=20, task_id="task1")
"""
from __future__ import annotations

import logging
import os

try:
    import requests
except ImportError:  # pragma: no cover - 优雅降级
    requests = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)

from .base_ds import (
    DISGENET_URL,
    BaseDataSource,
    RateLimiter,
    make_record,
)

HEADERS = {"User-Agent": "BioMedQAgent/1.0"}


def _auth_headers() -> dict:
    """构造带 API key 的请求头；缺失 key 时返回 None 哨兵。"""
    api_key = os.environ.get("DISGENET_API_KEY", "").strip()
    if not api_key:
        return None  # type: ignore[return-value]
    h = dict(HEADERS)
    h["Authorization"] = api_key
    return h


def search_disgenet(query: str, mode: str, max_results: int, task_id: str) -> list[dict]:
    headers = _auth_headers()
    if headers is None:
        raise RuntimeError("缺少环境变量 DISGENET_API_KEY，无法访问 DisGeNET API")
    limiter = RateLimiter(1.0)
    limiter.wait()
    # gene 模式按 gene_symbol 检索；disease 模式按 disease 检索
    if mode == "disease":
        params = {"disease": query, "source": "CURATED", "format": "json", "limit": max_results}
    else:
        params = {"gene_symbol": query, "source": "CURATED", "format": "json", "limit": max_results}
    r = requests.get(DISGENET_URL, params=params, headers=headers, timeout=60)
    r.raise_for_status()
    payload = r.json()
    # DisGeNET 返回可能是列表或 {"payload": [...]} 结构
    if isinstance(payload, dict):
        items = payload.get("payload", []) or payload.get("results", []) or []
    elif isinstance(payload, list):
        items = payload
    else:
        items = []
    records = []
    for it in items:
        if not isinstance(it, dict):
            continue
        gene_symbol = it.get("gene_symbol", "") or ""
        gene_id = it.get("geneid", "") or ""
        disease = it.get("disease_name", "") or ""
        disease_id = it.get("diseaseid", "") or ""
        fields = {
            "gene_symbol": gene_symbol,
            "gene_id": str(gene_id),
            "ncbi_gene_id": str(gene_id),
            "disease": disease,
            "disease_id": disease_id,
            "score": it.get("score", 0.0) or 0.0,
            "source": it.get("source", "") or "",
            "year_publication": it.get("year_publication", "") or "",
        }
        url = f"https://www.disgenet.org/gene/{gene_id}" if gene_id else None
        rec = make_record(
            task_id, "disgenet", fields, query,
            url=url, accession=str(gene_id) or None, confidence=0.9,
        )
        records.append(rec)
    return records


# ═══════════════════════════════════════════════════════════════════
# DisGeNETSource — BaseDataSource 子类（dormant 路径，含预设数据降级）
# ═══════════════════════════════════════════════════════════════════

_PRESET_GENE_DISEASES: dict[str, list[dict]] = {
    "TP53": [
        {"disease": "Breast cancer", "score": 0.98},
        {"disease": "Ovarian cancer", "score": 0.95},
        {"disease": "Colorectal cancer", "score": 0.93},
        {"disease": "Li-Fraumeni syndrome", "score": 0.99},
    ],
    "EGFR": [
        {"disease": "Non-small cell lung cancer", "score": 0.99},
        {"disease": "Glioblastoma", "score": 0.95},
        {"disease": "Colorectal cancer", "score": 0.90},
    ],
    "KRAS": [
        {"disease": "Pancreatic cancer", "score": 0.98},
        {"disease": "Colorectal cancer", "score": 0.96},
        {"disease": "Non-small cell lung cancer", "score": 0.92},
    ],
    "BRAF": [
        {"disease": "Melanoma", "score": 0.98},
        {"disease": "Thyroid cancer", "score": 0.93},
        {"disease": "Colorectal cancer", "score": 0.88},
    ],
    "BRCA1": [
        {"disease": "Breast cancer", "score": 0.97},
        {"disease": "Ovarian cancer", "score": 0.96},
    ],
    "PIK3CA": [
        {"disease": "Breast cancer", "score": 0.94},
        {"disease": "Colorectal cancer", "score": 0.90},
    ],
    "PTEN": [
        {"disease": "Prostate cancer", "score": 0.93},
        {"disease": "Endometrial cancer", "score": 0.91},
        {"disease": "Cowden syndrome", "score": 0.98},
    ],
    "ALK": [
        {"disease": "Non-small cell lung cancer", "score": 0.96},
        {"disease": "Neuroblastoma", "score": 0.92},
        {"disease": "Anaplastic large cell lymphoma", "score": 0.94},
    ],
    "IDH1": [
        {"disease": "Glioma", "score": 0.97},
        {"disease": "Acute myeloid leukemia", "score": 0.93},
    ],
    "MYC": [
        {"disease": "Burkitt lymphoma", "score": 0.95},
        {"disease": "Small cell lung cancer", "score": 0.88},
        {"disease": "Neuroblastoma", "score": 0.85},
    ],
}

_PRESET_DISEASE_GENES: dict[str, list[dict]] = {
    "breast cancer": [
        {"gene": "BRCA1", "score": 0.97},
        {"gene": "BRCA2", "score": 0.96},
        {"gene": "TP53", "score": 0.98},
        {"gene": "PIK3CA", "score": 0.94},
        {"gene": "ERBB2", "score": 0.90},
    ],
    "ovarian cancer": [
        {"gene": "BRCA1", "score": 0.96},
        {"gene": "BRCA2", "score": 0.95},
        {"gene": "TP53", "score": 0.95},
    ],
    "pancreatic cancer": [
        {"gene": "KRAS", "score": 0.98},
        {"gene": "TP53", "score": 0.93},
        {"gene": "CDKN2A", "score": 0.90},
        {"gene": "SMAD4", "score": 0.89},
    ],
    "melanoma": [
        {"gene": "BRAF", "score": 0.98},
        {"gene": "NRAS", "score": 0.95},
        {"gene": "CDKN2A", "score": 0.92},
    ],
    "lung cancer": [
        {"gene": "EGFR", "score": 0.99},
        {"gene": "KRAS", "score": 0.92},
        {"gene": "ALK", "score": 0.96},
        {"gene": "TP53", "score": 0.90},
    ],
    "colorectal cancer": [
        {"gene": "APC", "score": 0.98},
        {"gene": "KRAS", "score": 0.96},
        {"gene": "TP53", "score": 0.93},
        {"gene": "PIK3CA", "score": 0.90},
    ],
}


class DisGeNETSource(BaseDataSource):
    """DisGeNET 基因-疾病关联数据源（受控访问）。

    支持两种检索模式：
    - gene:    按基因符号查询关联疾病
    - disease: 按疾病名称查询关联基因

    DisGeNET API 需要 API key/email。无凭据时使用预设数据库。
    """

    name: str = "disgenet"
    description: str = "DisGeNET gene-disease associations (controlled access)"
    base_url: str = "https://www.disgenet.org/api/"
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
        mode = kwargs.get("mode", "gene")
        api_key = kwargs.get("api_key", "")
        email = kwargs.get("email", "")
        q = query.strip()

        if mode == "disease":
            return self._search_disease(q, max_results, task_id, api_key, email)
        return self._search_gene(q, max_results, task_id, api_key, email)

    # ── gene 模式 ──

    def _search_gene(self, query: str, max_results: int, task_id: str,
                     api_key: str = "", email: str = "") -> list[dict]:
        gene = query.strip().upper()

        if api_key and email:
            try:
                url = f"{self.base_url}gda/gene/{gene}"
                params = {"format": "json", "limit": max_results, "source": "CURATED"}
                headers = {"Authorization": api_key}
                data = self._get(url, params=params, headers=headers)
                records = self._parse_api_response(data, gene, max_results, task_id, "api")
                if records:
                    return records
            except Exception as e:
                logger.debug("disgenet: DisGeNET API 不可用: %s", e)

        return self._lookup_preset_gene(gene, max_results, task_id)

    def _lookup_preset_gene(self, gene: str, max_results: int,
                            task_id: str) -> list[dict]:
        diseases = _PRESET_GENE_DISEASES.get(gene, [])
        if not diseases:
            logger.info("disgenet: gene %s 无预设疾病关联数据", gene)
            return []

        records: list[dict] = []
        for d in diseases:
            fields = {
                "gene_symbol": gene,
                "disease": d["disease"],
                "score": d["score"],
                "source_database": "DisGeNET (preset)",
            }
            rec = make_record(
                task_id=task_id, source_name=self.name,
                fields=fields, query=gene,
                url=f"https://www.disgenet.org/browser/gene/{gene}",
                accession=gene, confidence=d["score"] * 0.85, method="preset",
            )
            records.append(rec)
            if len(records) >= max_results:
                break
        return records

    # ── disease 模式 ──

    def _search_disease(self, query: str, max_results: int, task_id: str,
                        api_key: str = "", email: str = "") -> list[dict]:
        disease_lower = query.strip().lower()

        if api_key and email:
            try:
                url = f"{self.base_url}gda/disease/{query}"
                params = {"format": "json", "limit": max_results, "source": "CURATED"}
                headers = {"Authorization": api_key}
                data = self._get(url, params=params, headers=headers)
                records = self._parse_api_response(data, query, max_results, task_id, "api")
                if records:
                    return records
            except Exception as e:
                logger.debug("disgenet: disease API 不可用: %s", e)

        return self._lookup_preset_disease(disease_lower, max_results, task_id)

    def _lookup_preset_disease(self, disease: str, max_results: int,
                                task_id: str) -> list[dict]:
        genes = None
        for known in _PRESET_DISEASE_GENES:
            if known in disease or disease in known:
                genes = _PRESET_DISEASE_GENES[known]
                break
        if not genes:
            logger.info("disgenet: disease %s 无预设基因关联数据", disease)
            return []

        records: list[dict] = []
        for g in genes:
            fields = {
                "disease": disease,
                "gene_symbol": g["gene"],
                "score": g["score"],
                "source_database": "DisGeNET (preset)",
            }
            rec = make_record(
                task_id=task_id, source_name=self.name,
                fields=fields, query=disease,
                url=f"https://www.disgenet.org/browser/disease/{disease}",
                accession=disease, confidence=g["score"] * 0.85, method="preset",
            )
            records.append(rec)
            if len(records) >= max_results:
                break
        return records

    # ── 共享 ──

    def _parse_api_response(self, data, query: str, max_results: int,
                            task_id: str, method: str) -> list[dict]:
        if isinstance(data, dict):
            items = data.get("payload", []) or data.get("results", []) or []
        elif isinstance(data, list):
            items = data
        else:
            return []

        records: list[dict] = []
        for it in items:
            if not isinstance(it, dict):
                continue
            fields = {
                "gene_symbol": it.get("gene_symbol", "") or "",
                "gene_id": str(it.get("geneid", "") or ""),
                "disease": it.get("disease_name", "") or "",
                "disease_id": str(it.get("diseaseid", "") or ""),
                "score": it.get("score", 0.0) or 0.0,
                "source_database": "DisGeNET",
            }
            rec = make_record(
                task_id=task_id, source_name=self.name,
                fields=fields, query=query,
                url=f"https://www.disgenet.org/browser/gda/{fields['gene_id']}",
                accession=fields["gene_id"] or query,
                confidence=0.85, method=method,
            )
            records.append(rec)
            if len(records) >= max_results:
                break
        return records
