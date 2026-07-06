"""OpenAlex 文献检索客户端。

OpenAlex 是开放学术数据库，覆盖 2.5 亿+作品，无需 API Key。
支持论文、作者、机构、概念、引用关系检索。
API: https://api.openalex.org/works
限速: 无 Key 限制 10 req/sec（保守取 1）

用法:
    python scripts/datasources/openalex_client.py --query "pancreatic cancer" --max 20 --out result.json
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

OPENALEX_URL = "https://api.openalex.org/works"
# mailto 参数用于 OpenAlex "polite pool"，享受更高限速（~100 req/s）
# 无需注册，只需提供联系邮箱即可
CONTACT_EMAIL = os.environ.get("OPENALEX_EMAIL", "biomed-qagent@example.com")
HEADERS = {"User-Agent": f"BioMedQAgent/1.0 (mailto:{CONTACT_EMAIL})"}


def search_openalex(query: str, max_results: int, task_id: str) -> list[dict]:
    limiter = RateLimiter(1.0)
    limiter.wait()
    params = {
        "search": query,
        "per-page": min(max_results, 25),
        "page": 1,
        "sort": "relevance_score:desc",
        "mailto": CONTACT_EMAIL,  # polite pool
    }
    # 429 限流时退避重试（最多 5 次，指数退避）
    import time as _time
    r = None
    for attempt in range(5):
        r = requests.get(OPENALEX_URL, params=params, headers=HEADERS, timeout=30)
        if r.status_code == 429:
            wait = 2 ** attempt  # 1s, 2s, 4s, 8s, 16s
            log_stderr(f"openalex: 429 限流，{wait}s 后重试（第 {attempt+1}/5 次）")
            _time.sleep(wait)
            continue
        break
    if r is None:
        raise RuntimeError("openalex 请求未发出")
    if r.status_code == 429:
        raise RuntimeError("openalex 429 限流，重试 5 次仍失败（请稍后重试或配置 OPENALEX_EMAIL）")
    r.raise_for_status()
    results = r.json().get("results", [])
    records = []
    for w in results:
        # 提取作者
        authors = []
        for au in w.get("authorships", []):
            name = au.get("author", {}).get("display_name", "")
            if name:
                authors.append(name)
        # 提取 DOI
        doi = w.get("doi", "") or ""
        doi = doi.replace("https://doi.org/", "") if doi else ""
        # 提取出版日期
        pub_date = w.get("publication_date", "") or ""
        # 提取开放获取 PDF 链接
        oa = w.get("open_access", {})
        oa_url = oa.get("oa_url", "") if oa else ""
        # best_oa_location 是顶层字段（含 pdf_url 供下载用）
        best_oa = w.get("best_oa_location") or {}
        if not isinstance(best_oa, dict):
            best_oa = {}
        # 提取主题（OpenAlex 用 topics 替代了 concepts）
        topics = []
        for c in (w.get("topics") or w.get("concepts") or [])[:5]:
            name = c.get("display_name", "")
            if name:
                topics.append(name)
        # 提取引用数
        cited_by = w.get("cited_by_count", 0)

        fields = {
            "openalex_id": w.get("id", "").replace("https://openalex.org/", ""),
            "title": w.get("title", "") or "",
            "abstract": _reconstruct_abstract(w.get("abstract_inverted_index")),
            "authors": authors,
            "journal": _get_journal(w),
            "pub_date": pub_date,
            "doi": doi,
            "oa_url": oa_url,
            "best_oa_location": best_oa,
            "topics": topics,
            "cited_by_count": cited_by,
        }
        url = w.get("id", "") or oa_url or None
        rec = make_record(
            task_id, "openalex", fields, query,
            url=url, doi=doi or None, confidence=0.95,
        )
        records.append(rec)
    return records


def _get_journal(work: dict) -> str:
    """从 OpenAlex 作品中提取期刊名（兼容新旧字段）。"""
    # 新版: primary_location.source.display_name
    pl = work.get("primary_location") or {}
    if isinstance(pl, dict):
        src = pl.get("source") or {}
        if isinstance(src, dict) and src.get("display_name"):
            return src["display_name"]
    # 旧版: host_venue.display_name
    hv = work.get("host_venue") or {}
    if isinstance(hv, dict) and hv.get("display_name"):
        return hv["display_name"]
    return ""


def _reconstruct_abstract(inverted_index) -> str:
    """OpenAlex 摘要为倒排索引格式，需重建为正文。"""
    if not inverted_index or not isinstance(inverted_index, dict):
        return ""
    positions = []
    for word, idxs in inverted_index.items():
        for idx in idxs:
            positions.append((idx, word))
    positions.sort()
    return " ".join(w for _, w in positions) if positions else ""


def main() -> None:
    parser = setup_cli("openalex_client", "OpenAlex 开放学术文献检索")
    args = parser.parse_args()
    if not args.query:
        emit_error("缺少 --query 参数")
        sys.exit(1)
    try:
        records = search_openalex(args.query, args.max, args.task_id)
        write_output(records, args.out)
        log_stderr(f"openalex: 返回 {len(records)} 条")
    except Exception as e:
        emit_error(f"openalex 检索失败: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
