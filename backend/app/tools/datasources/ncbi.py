"""NCBI Gene/Protein 数据库检索客户端。

API: NCBI E-utilities (esearch + esummary)
端点: https://eutils.ncbi.nlm.nih.gov/entrez/eutils/
限速: 1 req/sec

用法:
    from app.tools.datasources.ncbi import search_ncbi
    records = search_ncbi("TP53", "gene", 20, task_id)
"""
from __future__ import annotations

import requests

from .base_ds import (
    NCBI_EUTILS,
    RateLimiter,
    make_record,
)

ESEARCH_URL = f"{NCBI_EUTILS}/esearch.fcgi"
ESUMMARY_URL = f"{NCBI_EUTILS}/esummary.fcgi"
HEADERS = {"User-Agent": "BioMedQAgent/1.0"}


def _organism_name(val) -> str:
    """esummary 中 organism 可能是 dict 或字符串。"""
    if isinstance(val, dict):
        return val.get("scientificname", "") or val.get("name", "")
    return str(val or "")


def search_ncbi(query: str, db: str, max_results: int, task_id: str) -> list[dict]:
    limiter = RateLimiter(1.0)
    # 1. esearch 获取 UID 列表
    limiter.wait()
    params = {"db": db, "term": query, "retmax": max_results, "retmode": "json"}
    r = requests.get(ESEARCH_URL, params=params, headers=HEADERS, timeout=30)
    r.raise_for_status()
    id_list = r.json().get("esearchresult", {}).get("idlist", [])
    if not id_list:
        return []
    # 2. esummary 获取摘要信息（JSON）
    limiter.wait()
    params = {"db": db, "id": ",".join(id_list), "retmode": "json"}
    r = requests.get(ESUMMARY_URL, params=params, headers=HEADERS, timeout=60)
    r.raise_for_status()
    data = r.json().get("result", {})
    source_name = f"ncbi_{db}"
    records = []
    for uid in id_list:
        item = data.get(uid, {})
        if not item or "error" in item:
            continue
        if db == "gene":
            aliases = item.get("aliases", []) or []
            if isinstance(aliases, str):
                aliases = [a.strip() for a in aliases.split(",") if a.strip()]
            fields = {
                "gene_id": uid,
                "symbol": item.get("name", ""),
                "name": item.get("description", ""),
                "organism": _organism_name(item.get("organism")),
                "aliases": aliases,
                "summary": item.get("summary", ""),
                "chromosome": item.get("chromosome", ""),
            }
            url = f"https://www.ncbi.nlm.nih.gov/gene/{uid}"
        else:  # protein
            fields = {
                "protein_id": uid,
                "definition": item.get("title", ""),
                "organism": _organism_name(item.get("organism")),
                "length": item.get("slen", 0),
            }
            url = f"https://www.ncbi.nlm.nih.gov/protein/{uid}"
        rec = make_record(
            task_id, source_name, fields, query,
            url=url, accession=uid, confidence=1.0,
        )
        records.append(rec)
    return records
