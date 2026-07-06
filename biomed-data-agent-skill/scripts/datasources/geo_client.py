"""GEO 基因表达数据集检索客户端。

API: NCBI E-utilities (esearch on gds + esummary)
端点: https://eutils.ncbi.nlm.nih.gov/entrez/eutils/
限速: 1 req/sec

用法:
    python scripts/datasources/geo_client.py --query "pancreatic cancer" --max 20 --out result.json
"""
from __future__ import annotations

import sys

import requests

from _base import (
    GEO_URL,
    RateLimiter,
    emit_error,
    log_stderr,
    make_record,
    setup_cli,
    write_output,
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


def main() -> None:
    parser = setup_cli("geo_client", "GEO 基因表达数据集检索（NCBI gds）")
    args = parser.parse_args()
    if not args.query:
        emit_error("缺少 --query 参数")
        sys.exit(1)
    try:
        records = search_geo(args.query, args.max, args.task_id)
        write_output(records, args.out)
        log_stderr(f"geo: 返回 {len(records)} 条数据集")
    except Exception as e:
        emit_error(f"geo 检索失败: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
