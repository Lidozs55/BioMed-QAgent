"""引用追溯工具 — 基于 OpenAlex 引用网络扩展文献检索。

系统综述核心方法：找到关键文献后，追溯其参考文献（被它引用的文献）和
被引文献（引用它的文献），可显著扩展相关文献覆盖范围。

OpenAlex API：
- 参考文献：Work 对象的 `referenced_works` 字段（OpenAlex ID 列表）
  批量获取：filter=openalex_id:W1|W2|...
- 被引文献：filter=cites:W123

作为模块使用：
    from app.tools.datasources.citation_trace import trace_citations
    new_records = trace_citations(existing_records, 20, "task-1")
"""
from __future__ import annotations

import logging
import time

import requests

from .base_ds import RateLimiter, make_record
from .openalex import (
    CONTACT_EMAIL,
    HEADERS,
    OPENALEX_URL,
    _get_journal,
    _reconstruct_abstract,
)

logger = logging.getLogger(__name__)

# OpenAlex 批量 filter 单次最多 50 个 ID（API 实际可到 ~100，保守取 50）
_BATCH_SIZE = 50


def trace_citations(
    records: list[dict],
    max_results: int = 20,
    task_id: str = "T0",
    direction: str = "both",
    top_n: int = 5,
) -> list[dict]:
    """对关键文献进行引用追溯（参考文献 + 被引文献）。

    Args:
        records: 已检索的文献记录列表（取 cited_by_count top N 作为种子）
        max_results: 每个方向返回的最大记录数（总记录数 ≤ 2 × max_results）
        task_id: 任务 ID
        direction: "refs"（参考文献）| "cited_by"（被引）| "both"
        top_n: 取前 N 篇高被引文献作为追溯种子

    Returns:
        新的文献记录列表（不含原始种子记录，由调用方按 record_id 去重）
    """
    seeds = _select_seed_works(records, top_n)
    if not seeds:
        logger.info("citation_trace: 无可用种子文献（缺 openalex_id），跳过")
        return []

    limiter = RateLimiter(1.0)
    do_refs = direction in ("refs", "both")
    do_cited = direction in ("cited_by", "both")

    new_records: list[dict] = []
    seen_ids: set[str] = set(s["openalex_id"] for s in seeds)

    # 1. 参考文献：批量获取种子 referenced_works，再批量拉取详情
    if do_refs:
        ref_ids = _fetch_referenced_works(seeds, limiter)
        ref_records = _batch_fetch_works(
            ref_ids, max_results, task_id, "citation_ref", seen_ids, limiter,
        )
        new_records.extend(ref_records)
        logger.info("citation_trace: 参考文献追溯得到 %d 条", len(ref_records))

    # 2. 被引文献：每个种子用 filter=cites:Wxxx 查询
    if do_cited:
        per_seed = max(max_results // max(len(seeds), 1), 5)
        cited_count = 0
        for seed in seeds:
            cited_records = _fetch_cited_by(
                seed["openalex_id"], per_seed, task_id, seen_ids, limiter,
            )
            new_records.extend(cited_records)
            cited_count += len(cited_records)
            if len(new_records) >= max_results * 2:
                break
        logger.info("citation_trace: 被引文献追溯得到 %d 条（累计 %d）",
                    cited_count, len(new_records))

    return new_records[:max_results * 2]


def _select_seed_works(records: list[dict], top_n: int) -> list[dict]:
    """从记录中筛选含 openalex_id 的文献，按被引数降序取 top N。

    Returns:
        [{"openalex_id": "W123", "title": "...", "cited_by_count": 42}, ...]
    """
    candidates: list[dict] = []
    for r in records:
        fields = r.get("fields", {})
        oa_id = fields.get("openalex_id", "")
        if not oa_id:
            continue
        # 规范化 ID（去掉 URL 前缀）
        if oa_id.startswith("http"):
            oa_id = oa_id.replace("https://openalex.org/", "")
        candidates.append({
            "openalex_id": oa_id,
            "title": fields.get("title", ""),
            "cited_by_count": fields.get("cited_by_count", 0) or 0,
        })
    # 按被引数降序，取 top N
    candidates.sort(key=lambda x: x["cited_by_count"], reverse=True)
    return candidates[:top_n]


def _fetch_referenced_works(seeds: list[dict], limiter: RateLimiter) -> list[str]:
    """批量获取所有种子的 referenced_works（去重）。

    每个种子的 Work 详情包含 referenced_works 字段（OpenAlex ID 列表）。
    """
    all_ref_ids: list[str] = []
    for seed in seeds:
        limiter.wait()
        url = f"{OPENALEX_URL}/{seed['openalex_id']}"
        params = {"mailto": CONTACT_EMAIL, "select": "referenced_works"}
        try:
            r = requests.get(url, params=params, headers=HEADERS, timeout=30)
            if r.status_code == 429:
                time.sleep(2)
                r = requests.get(url, params=params, headers=HEADERS, timeout=30)
            r.raise_for_status()
            refs = r.json().get("referenced_works", []) or []
            # 规范化 ID（去掉 URL 前缀）
            for ref in refs:
                rid = ref.replace("https://openalex.org/", "") if isinstance(ref, str) else ""
                if rid:
                    all_ref_ids.append(rid)
        except Exception as e:
            logger.warning("citation_trace: 获取 %s referenced_works 失败: %s",
                           seed["openalex_id"], e)

    # 去重（保持顺序）
    seen: set[str] = set()
    unique: list[str] = []
    for rid in all_ref_ids:
        if rid not in seen:
            seen.add(rid)
            unique.append(rid)
    return unique


def _batch_fetch_works(
    openalex_ids: list[str],
    max_results: int,
    task_id: str,
    query_label: str,
    seen_ids: set[str],
    limiter: RateLimiter,
) -> list[dict]:
    """批量获取多个 OpenAlex Work 的详情并转为 records。

    使用 filter=openalex_id:W1|W2|... 语法，单次最多 _BATCH_SIZE 个 ID。
    """
    if not openalex_ids:
        return []

    records: list[dict] = []
    fetched = 0
    for i in range(0, len(openalex_ids), _BATCH_SIZE):
        if fetched >= max_results:
            break
        batch = openalex_ids[i:i + _BATCH_SIZE]
        limiter.wait()
        params = {
            "filter": "|".join(f"openalex_id:{wid}" for wid in batch),
            "per-page": min(len(batch), max_results - fetched),
            "mailto": CONTACT_EMAIL,
        }
        try:
            r = requests.get(OPENALEX_URL, params=params,
                             headers=HEADERS, timeout=30)
            if r.status_code == 429:
                time.sleep(2)
                r = requests.get(OPENALEX_URL, params=params,
                                 headers=HEADERS, timeout=30)
            r.raise_for_status()
            results = r.json().get("results", [])
        except Exception as e:
            logger.warning("citation_trace: 批量获取 works 失败: %s", e)
            continue

        for w in results:
            oa_id = (w.get("id", "") or "").replace("https://openalex.org/", "")
            if not oa_id or oa_id in seen_ids:
                continue
            seen_ids.add(oa_id)
            rec = _work_to_record(w, task_id, query_label)
            if rec:
                records.append(rec)
                fetched += 1
                if fetched >= max_results:
                    break
    return records


def _fetch_cited_by(
    seed_id: str,
    max_results: int,
    task_id: str,
    seen_ids: set[str],
    limiter: RateLimiter,
) -> list[dict]:
    """获取引用某种子文献的文献列表（filter=cites:Wxxx）。"""
    limiter.wait()
    params = {
        "filter": f"cites:{seed_id}",
        "per-page": min(max_results, 25),
        "sort": "cited_by_count:desc",
        "mailto": CONTACT_EMAIL,
    }
    try:
        r = requests.get(OPENALEX_URL, params=params,
                         headers=HEADERS, timeout=30)
        if r.status_code == 429:
            time.sleep(2)
            r = requests.get(OPENALEX_URL, params=params,
                             headers=HEADERS, timeout=30)
        r.raise_for_status()
        results = r.json().get("results", [])
    except Exception as e:
        logger.warning("citation_trace: 获取 %s cited_by 失败: %s", seed_id, e)
        return []

    records: list[dict] = []
    for w in results:
        oa_id = (w.get("id", "") or "").replace("https://openalex.org/", "")
        if not oa_id or oa_id in seen_ids:
            continue
        seen_ids.add(oa_id)
        rec = _work_to_record(w, task_id, "citation_cited_by")
        if rec:
            records.append(rec)
            if len(records) >= max_results:
                break
    return records


def _work_to_record(w: dict, task_id: str, query_label: str) -> dict | None:
    """OpenAlex Work 对象转 DataRecord（与 openalex.py 字段对齐）。"""
    oa_id = (w.get("id", "") or "").replace("https://openalex.org/", "")
    if not oa_id:
        return None

    authors: list[str] = []
    for au in w.get("authorships", []):
        name = au.get("author", {}).get("display_name", "")
        if name:
            authors.append(name)

    doi = w.get("doi", "") or ""
    doi = doi.replace("https://doi.org/", "") if doi else ""

    oa = w.get("open_access", {}) or {}
    oa_url = oa.get("oa_url", "") if oa else ""
    best_oa = w.get("best_oa_location") or {}
    if not isinstance(best_oa, dict):
        best_oa = {}

    topics: list[str] = []
    for c in (w.get("topics") or w.get("concepts") or [])[:5]:
        name = c.get("display_name", "")
        if name:
            topics.append(name)

    fields = {
        "openalex_id": oa_id,
        "title": w.get("title", "") or "",
        "abstract": _reconstruct_abstract(w.get("abstract_inverted_index")),
        "authors": authors,
        "journal": _get_journal(w),
        "pub_date": w.get("publication_date", "") or "",
        "doi": doi,
        "oa_url": oa_url,
        "best_oa_location": best_oa,
        "topics": topics,
        "cited_by_count": w.get("cited_by_count", 0) or 0,
    }
    url = w.get("id", "") or oa_url or None
    return make_record(
        task_id, "openalex_citation_trace", fields, query_label,
        url=url, doi=doi or None, confidence=0.85,
    )
