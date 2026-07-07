"""RCSB PDB 蛋白质结构检索客户端。

API: RCSB Search API + Data API
端点:
  - 检索: https://search.rcsb.org/rcsbsearch/v2/query
  - 详情: https://data.rcsb.org/rest/v1/core/entry/<pdb_id>
限速: 1 req/sec

用法:
    from app.tools.datasources.pdb import search_pdb
    records = search_pdb("insulin", 20, task_id)
"""
from __future__ import annotations

import requests

from .base_ds import (
    PDB_URL,
    RateLimiter,
    make_record,
)

DATA_ENTRY_URL = "https://data.rcsb.org/rest/v1/core/entry"
DATA_ENTITY_URL = "https://data.rcsb.org/rest/v1/core/entity"
HEADERS = {"User-Agent": "BioMedQAgent/1.0", "Content-Type": "application/json"}


def _get_organism(pdb_id: str) -> str:
    """从 entity 1 获取来源物种名（best-effort）。"""
    try:
        r = requests.get(f"{DATA_ENTITY_URL}/{pdb_id}/1", headers=HEADERS, timeout=30)
        if r.status_code != 200:
            return ""
        d = r.json()
        orgs = d.get("rcsb_entity_source_organism", []) or []
        if orgs:
            return orgs[0].get("scientific_name", "") or orgs[0].get("ncbi_scientific_name", "")
    except Exception:
        pass
    return ""


def search_pdb(query: str, max_results: int, task_id: str) -> list[dict]:
    limiter = RateLimiter(1.0)
    # 1. 搜索 API：按结构标题文本检索
    body = {
        "query": {
            "type": "terminal",
            "service": "text",
            "parameters": {"attribute": "struct.title", "operator": "contains", "value": query},
        },
        "return_type": "entry",
        "request_options": {"paginate": {"start": 0, "rows": max_results}},
    }
    limiter.wait()
    r = requests.post(PDB_URL, json=body, headers=HEADERS, timeout=60)
    r.raise_for_status()
    data = r.json()
    hits = data.get("result_set", []) or data.get("results", [])
    records = []
    for hit in hits:
        pdb_id = hit.get("identifier", "") if isinstance(hit, dict) else str(hit)
        if not pdb_id:
            continue
        limiter.wait()
        dr = requests.get(f"{DATA_ENTRY_URL}/{pdb_id}", headers=HEADERS, timeout=30)
        if dr.status_code != 200:
            continue
        d = dr.json()
        struct = d.get("struct", {}) or {}
        exptl = d.get("exptl", [{}]) or [{}]
        first = exptl[0] if exptl else {}
        ligands = []
        for ld in d.get("rcsb_entry_info", {}).get("nonpolymer_bound_components", []) or []:
            if isinstance(ld, dict):
                ligands.append(ld.get("id", ""))
            else:
                ligands.append(str(ld))
        fields = {
            "pdb_id": pdb_id,
            "title": struct.get("title", ""),
            "organism": _get_organism(pdb_id),
            "resolution": first.get("resolution", 0.0),
            "method": first.get("method", ""),
            "deposition_date": d.get("rcsb_accession_info", {}).get("initial_deposition_date", ""),
            "ligands": ligands,
        }
        url = f"https://www.rcsb.org/structure/{pdb_id}"
        rec = make_record(task_id, "pdb", fields, query, url=url, accession=pdb_id, confidence=1.0)
        records.append(rec)
    return records
