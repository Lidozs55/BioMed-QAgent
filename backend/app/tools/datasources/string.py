"""STRING 蛋白质互作网络检索客户端。

API: STRING DB
端点: https://string-db.org/api/json/network
限速: 1 req/sec

用法:
    from app.tools.datasources.string import search_string
    records = search_string("TP53", 9606, 50, task_id)
"""
from __future__ import annotations

import logging

import requests

from .base_ds import (
    STRING_URL,
    RateLimiter,
    make_record,
)

logger = logging.getLogger(__name__)

NETWORK_URL = f"{STRING_URL}/json/network"
HEADERS = {"User-Agent": "BioMedQAgent/1.0"}


def search_string(query: str, species: int, max_results: int, task_id: str) -> list[dict]:
    limiter = RateLimiter(1.0)
    limiter.wait()
    # 调用 /api/json/network 获取互作边
    params = {
        "identifier": query,
        "species": species,
        "limit": max_results,
        "caller_identity": "BioMedQAgent",
    }
    r = requests.get(NETWORK_URL, params=params, headers=HEADERS, timeout=60)
    if r.status_code == 400:
        # 非基因符号查询（如中文研究目标）会返回 400，优雅返回空
        logger.warning("string: 查询 '%s' 不是有效基因符号（400），跳过", query[:30])
        return []
    r.raise_for_status()
    items = r.json()
    records = []
    for it in items:
        protein_a = it.get("preferredName_A", "") or it.get("stringId_A", "")
        protein_b = it.get("preferredName_B", "") or it.get("stringId_B", "")
        score = it.get("score", 0.0)
        evidence = {
            "experimental": it.get("experimental", 0),
            "database": it.get("database", 0),
            "textmining": it.get("textmining", 0),
            "coexpression": it.get("coexpression", 0),
        }
        fields = {
            "protein_a": protein_a,
            "protein_b": protein_b,
            "score": score,
            "evidence": evidence,
            "species": species,
        }
        string_id_a = it.get("stringId_A", "")
        url = f"https://string-db.org/network/{string_id_a}" if string_id_a else None
        rec = make_record(
            task_id, "string", fields, query,
            url=url, confidence=0.95,
        )
        records.append(rec)
    return records
