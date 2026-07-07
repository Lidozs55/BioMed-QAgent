"""GEO 基因表达数据集检索客户端。

API: NCBI E-utilities (esearch on gds + esummary)
端点: https://eutils.ncbi.nlm.nih.gov/entrez/eutils/
限速: 1 req/sec

作为模块使用：
    from app.tools.datasources.geo import search_geo
    records = search_geo("pancreatic cancer", 20, "task-1")
"""
from __future__ import annotations

import requests

from .base_ds import (
    GEO_URL,
    RateLimiter,
    make_record,
)

ESEARCH_URL = f"{GEO_URL}/esearch.fcgi"
ESUMMARY_URL = f"{GEO_URL}/esummary.fcgi"
HEADERS = {"User-Agent": "BioMedQAgent/1.0"}


def search_geo(query: str, max_results: int, task_id: str) -> list[dict]:
    limiter = RateLimiter(1.0)
    # 1. 在 gds 数据库检索 GEO DataSets
    limiter.wait()
    params = {"db": "gds", "term": query, "retmax": max_results, "retmode": "json"}
    r = requests.get(ESEARCH_URL, params=params, headers=HEADERS, timeout=30)
    r.raise_for_status()
    id_list = r.json().get("esearchresult", {}).get("idlist", [])
    if not id_list:
        return []
    # 2. esummary 获取数据集详情
    limiter.wait()
    params = {"db": "gds", "id": ",".join(id_list), "retmode": "json"}
    r = requests.get(ESUMMARY_URL, params=params, headers=HEADERS, timeout=60)
    r.raise_for_status()
    data = r.json().get("result", {})
    records = []
    for uid in id_list:
        item = data.get(uid, {})
        if not item or "error" in item:
            continue
        geo_id = item.get("accession", "")
        fields = {
            "geo_id": geo_id,
            "title": item.get("title", ""),
            "summary": item.get("summary", ""),
            "organism": item.get("taxon", ""),
            "sample_count": item.get("n_samples", 0),
            "platform": item.get("gpl", ""),
            "pub_date": item.get("pdat", ""),
            "entry_type": item.get("entrytype", ""),
        }
        url = f"https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc={geo_id}" if geo_id else None
        rec = make_record(
            task_id, "geo", fields, query,
            url=url, accession=geo_id or None, confidence=1.0,
        )
        records.append(rec)
    return records
