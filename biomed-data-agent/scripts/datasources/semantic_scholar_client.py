"""Semantic Scholar 文献检索客户端。

Semantic Scholar 提供 AI 驱动的学术搜索 API，支持语义检索。
API: https://api.semanticscholar.org/graph/v1
限速: 无 Key 100 req/5min（保守取 1 req/sec）；有 Key 1 req/sec
认证: 可选 SEMANTIC_SCHOLAR_API_KEY 环境变量提升限速配额

用法:
    python scripts/datasources/semantic_scholar_client.py --query "pancreatic cancer" --max 20 --out result.json
"""
from __future__ import annotations

import os
import sys

import requests

from _base import (
    RateLimiter,
    emit_error,
    log_stderr,
    make_record,
    setup_cli,
    write_output,
)

S2_SEARCH_URL = "https://api.semanticscholar.org/graph/v1/paper/search"
S2_API_KEY = os.environ.get("SEMANTIC_SCHOLAR_API_KEY", "").strip()
HEADERS = {"User-Agent": "BioMedQAgent/1.0"}
if S2_API_KEY:
    HEADERS["x-api-key"] = S2_API_KEY
FIELDS = (
    "paperId,title,abstract,authors.name,authors.affiliations,"
    "year,venue,externalIds,openAccessPdf,citationCount,influentialCitationCount,"
    "publicationTypes,publicationDate,tldr"
)


def search_s2(query: str, max_results: int, task_id: str) -> list[dict]:
    limiter = RateLimiter(1.0)
    limiter.wait()
    params = {
        "query": query,
        "limit": min(max_results, 50),
        "fields": FIELDS,
        "sort": "relevance",
    }
    # 429 限流时退避重试（最多 5 次，指数退避）
    import time as _time
    r = None
    for attempt in range(5):
        r = requests.get(S2_SEARCH_URL, params=params, headers=HEADERS, timeout=30)
        if r.status_code == 429:
            wait = 2 ** attempt
            log_stderr(f"semantic_scholar: 429 限流，{wait}s 后重试（第 {attempt+1}/5 次）")
            _time.sleep(wait)
            continue
        break
    if r is None:
        raise RuntimeError("semantic_scholar 请求未发出")
    if r.status_code == 429:
        raise RuntimeError("semantic_scholar 429 限流，重试 5 次仍失败（无 Key 配额：100 req/5min）")
    r.raise_for_status()
    data = r.json()
    results = data.get("data", [])
    records = []
    for w in results:
        authors = [a.get("name", "") for a in w.get("authors", []) if a.get("name")]
        ext_ids = w.get("externalIds", {}) or {}
        doi = ext_ids.get("DOI", "") or ""
        pmid = ext_ids.get("PubMed", "") or ""
        arxiv_id = ext_ids.get("ArXiv", "") or ""
        oa_pdf = w.get("openAccessPdf", {})
        pdf_url = oa_pdf.get("url", "") if isinstance(oa_pdf, dict) else ""
        tldr = w.get("tldr", {})
        abstract = w.get("abstract", "") or ""
        if not abstract and tldr and isinstance(tldr, dict):
            abstract = tldr.get("text", "") or ""
        pub_types = w.get("publicationTypes", []) or []
        fields = {
            "s2_id": w.get("paperId", ""),
            "title": w.get("title", "") or "",
            "abstract": abstract,
            "authors": authors,
            "journal": w.get("venue", "") or "",
            "pub_date": str(w.get("year", "") or ""),
            "doi": doi,
            "pmid": pmid,
            "arxiv_id": arxiv_id,
            "pdf_url": pdf_url,
            "citation_count": w.get("citationCount", 0),
            "influential_citation_count": w.get("influentialCitationCount", 0),
            "publication_types": pub_types,
        }
        url = pdf_url or f"https://www.semanticscholar.org/paper/{w.get('paperId', '')}" or None
        rec = make_record(
            task_id, "semantic_scholar", fields, query,
            url=url, doi=doi or None, pmid=pmid or None, confidence=0.93,
        )
        records.append(rec)
    return records


def main() -> None:
    parser = setup_cli("semantic_scholar_client", "Semantic Scholar 学术文献语义检索")
    args = parser.parse_args()
    if not args.query:
        emit_error("缺少 --query 参数")
        sys.exit(1)
    try:
        records = search_s2(args.query, args.max, args.task_id)
        write_output(records, args.out)
        log_stderr(f"semantic_scholar: 返回 {len(records)} 条")
    except Exception as e:
        emit_error(f"semantic_scholar 检索失败: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
