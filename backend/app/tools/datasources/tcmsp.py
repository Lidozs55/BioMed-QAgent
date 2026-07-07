"""TCMSP 中药成分检索客户端。

TCMSP 网站无官方 API，本模块尝试调用其内部 JSON 接口（tcmspsearch.php）。
若接口被封锁或不可用，返回 None 信号供上游爬虫处理。
端点: https://tcmspw.com/tcmspsearch.php
限速: 1 req/sec

用法:
    from app.tools.datasources.tcmsp import _query_tcmsp
    records = _query_tcmsp({"herbName": "三七", "pageNum": "1", "pageSize": "20"}, task_id, "三七")
"""
from __future__ import annotations

import logging

import requests

from .base_ds import (
    TCMSP_URL,
    RateLimiter,
    make_record,
)

logger = logging.getLogger(__name__)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Referer": "https://tcmspw.com/tcmsp.php",
    "X-Requested-With": "XMLHttpRequest",
}


def _query_tcmsp(form_data: dict, task_id: str, query_label: str) -> list[dict] | None:
    """调用 TCMSP 内部接口，返回记录列表；接口不可用时返回 None。"""
    limiter = RateLimiter(1.0)
    limiter.wait()
    try:
        r = requests.post(TCMSP_URL, data=form_data, headers=HEADERS, timeout=30)
        r.raise_for_status()
        items = r.json()
    except Exception as e:
        logger.warning("tcmsp 接口不可用: %s", e)
        return None
    if isinstance(items, dict):
        items = items.get("data", []) or items.get("rows", [])
    records = []
    for it in items if isinstance(items, list) else []:
        if not isinstance(it, dict):
            continue
        fields = {
            "compound_name": it.get("Molecule Name") or it.get("Name") or "",
            "mw": it.get("MW") or it.get("Molecular Weight") or 0,
            "ob": it.get("OB") or it.get("Oral Bioavailability") or 0,
            "dl": it.get("DL") or it.get("Drug-likeness") or 0,
            "targets": [],  # 靶点需另查 /targets 接口，此处留空
        }
        rec = make_record(
            task_id, "tcmsp", fields, query_label,
            url=TCMSP_URL, confidence=0.7,
        )
        records.append(rec)
    return records
