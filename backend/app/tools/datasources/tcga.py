"""TCGA GDC（Genomic Data Commons）检索客户端。

API: GDC API
端点: https://api.gdc.cancer.gov
  - cases: 病例检索（disease_type, primary_site, demographics）
  - genes: mRNA-seq 基因表达文件检索
限速: 1 req/sec

用法:
    from app.tools.datasources.tcga import search_tcga
    records = search_tcga("Breast Cancer", search_type="cases", max_results=20, task_id="task1")
    records = search_tcga("BRCA1", search_type="genes", max_results=20, task_id="task1")
"""
from __future__ import annotations

try:
    import requests
except ImportError:  # pragma: no cover - 优雅降级
    requests = None  # type: ignore[assignment]

from .base_ds import (
    GDC_URL,
    RateLimiter,
    make_record,
)

CASES_URL = f"{GDC_URL}/cases"
FILES_URL = f"{GDC_URL}/files"
HEADERS = {"User-Agent": "BioMedQAgent/1.0", "Content-Type": "application/json"}


def _build_filter(query: str, field: str) -> dict:
    """构造 GDC filter（包含匹配）。"""
    return {
        "op": "and",
        "content": [
            {"op": "~", "content": {"field": field, "value": query}}
        ],
    }


def _post(url: str, body: dict, limiter: RateLimiter) -> dict:
    limiter.wait()
    r = requests.post(url, json=body, headers=HEADERS, timeout=60)
    r.raise_for_status()
    return r.json()


def _search_cases(query: str, max_results: int, task_id: str, limiter: RateLimiter) -> list[dict]:
    body = {
        "filters": _build_filter(query, "disease_type"),
        "fields": ",".join([
            "case_id", "submitter_id", "disease_type", "primary_site",
            "demographics.gender", "diagnoses.year_of_diagnosis",
            "diagnoses.vital_status", "diagnoses.survival_months",
        ]),
        "size": str(max_results),
    }
    data = _post(CASES_URL, body, limiter)
    hits = data.get("data", {}).get("hits", []) or []
    records = []
    for h in hits:
        if not isinstance(h, dict):
            continue
        c = h.get("case_id", "") or ""
        demo = h.get("demographics", {}) or {}
        diag_list = h.get("diagnoses", []) or []
        diag = diag_list[0] if isinstance(diag_list, list) and diag_list else (diag_list or {})
        if not isinstance(diag, dict):
            diag = {}
        fields = {
            "case_id": c,
            "submitter_id": h.get("submitter_id", "") or "",
            "disease_type": _first(h.get("disease_type", [])),
            "disease_types": h.get("disease_type", []) or [],
            "primary_site": _first(h.get("primary_site", [])),
            "gender": demo.get("gender", "") or "",
            "year_of_diagnosis": diag.get("year_of_diagnosis", "") or "",
            "vital_status": diag.get("vital_status", "") or "",
            "survival_months": diag.get("survival_months", 0) or 0,
        }
        url = f"https://portal.gdc.cancer.gov/cases/{c}" if c else None
        rec = make_record(
            task_id, "tcga", fields, query,
            url=url, accession=c or None, confidence=1.0,
        )
        records.append(rec)
    return records


def _search_genes(query: str, max_results: int, task_id: str, limiter: RateLimiter) -> list[dict]:
    body = {
        "filters": {
            "op": "and",
            "content": [
                {"op": "=", "content": {"field": "data_category", "value": "Transcriptome Profiling"}},
                {"op": "=", "content": {"field": "data_type", "value": "Gene Expression Quantification"}},
                {"op": "~", "content": {"field": "cases.submitter_id", "value": query}},
            ],
        },
        "fields": ",".join([
            "file_id", "file_name", "data_category", "data_type",
            "experimental_strategy", "cases.case_id", "cases.submitter_id",
            "cases.disease_type",
        ]),
        "size": str(max_results),
    }
    data = _post(FILES_URL, body, limiter)
    hits = data.get("data", {}).get("hits", []) or []
    records = []
    for h in hits:
        if not isinstance(h, dict):
            continue
        f = h.get("file_id", "") or ""
        cases = h.get("cases", []) or []
        case = cases[0] if isinstance(cases, list) and cases else (cases or {})
        if not isinstance(case, dict):
            case = {}
        fields = {
            "file_id": f,
            "file_name": h.get("file_name", "") or "",
            "data_category": h.get("data_category", "") or "",
            "data_type": h.get("data_type", "") or "",
            "experimental_strategy": h.get("experimental_strategy", "") or "",
            "case_id": case.get("case_id", "") or "",
            "submitter_id": case.get("submitter_id", "") or "",
            "disease_type": _first(case.get("disease_type", [])),
            "gene_symbol": query,
        }
        url = f"https://portal.gdc.cancer.gov/files/{f}" if f else None
        rec = make_record(
            task_id, "tcga", fields, query,
            url=url, accession=f or None, confidence=0.85,
        )
        records.append(rec)
    return records


def _first(value) -> str:
    """从字符串或列表中取第一个非空元素。"""
    if isinstance(value, list):
        return value[0] if value else ""
    return str(value or "")


def search_tcga(query: str, search_type: str, max_results: int, task_id: str) -> list[dict]:
    limiter = RateLimiter(1.0)
    if search_type == "genes":
        return _search_genes(query, max_results, task_id, limiter)
    return _search_cases(query, max_results, task_id, limiter)
