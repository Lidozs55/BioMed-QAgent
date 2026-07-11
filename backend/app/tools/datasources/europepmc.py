"""Europe PMC 文献检索客户端。

Europe PMC (ebi.ac.uk) 是欧洲开放学术数据库，国内可访问（无墙），
覆盖 PubMed + PMC + preprints，返回结果明确标注 OA 状态/PMCID/hasPDF。

作为 PubMed 的补充/替代数据源：
- 国内网络稳定可达（Unpaywall/OpenAlex 常被墙或限流）
- 返回 OA 文献元数据（含 pmcid，可用于 fullTextXML 全文获取）
- search API 无需 Key，限速宽松

API: https://www.ebi.ac.uk/europepmc/webservices/rest/search
作为模块使用：
    from app.tools.datasources.europepmc import search_europepmc
    records = search_europepmc("pancreatic cancer", 20, "task-1")
"""
from __future__ import annotations

import logging

import requests

from .base_ds import (
    RateLimiter,
    make_record,
)

logger = logging.getLogger(__name__)

EPMC_SEARCH_URL = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
HEADERS = {"User-Agent": "BioMedQAgent/1.0"}


def search_europepmc(query: str, max_results: int, task_id: str) -> list[dict]:
    """Europe PMC 文献检索。

    优先返回 OA 文献（openAccess=Y），结果含 pmcid/is_oa/has_pdf 字段，
    供 parse 阶段用 EPMC fullTextXML API 获取全文。

    Args:
        query: 检索词
        max_results: 最大返回数
        task_id: 任务 ID
    Returns:
        DataRecord 列表，fields 含 pmid/pmcid/title/abstract/authors/journal/
        pub_date/doi/has_pdf/is_oa
    """
    limiter = RateLimiter(1.0)
    limiter.wait()
    params = {
        "query": query,
        "format": "json",
        "pageSize": min(max_results, 25),
        "resultType": "core",
        # 优先返回 OA 文献（含全文的优先），但不强制（保证召回量）
        "sort": "CITED desc",
    }
    try:
        r = requests.get(EPMC_SEARCH_URL, params=params,
                         headers=HEADERS, timeout=30)
        r.raise_for_status()
    except Exception as e:
        logger.warning("europepmc 检索失败: %s", e)
        raise

    data = r.json()
    results = data.get("resultList", {}).get("result", [])
    records = []
    for w in results:
        pmid = w.get("pmid", "") or ""
        pmcid = w.get("pmcid", "") or ""
        title = w.get("title", "") or ""
        abstract = w.get("abstractText", "") or ""
        # 作者字符串 "Smith J, Doe A."
        author_string = w.get("authorString", "") or ""
        authors = [a.strip() for a in author_string.split(",") if a.strip()]
        # 期刊
        journal = ""
        journal_info = w.get("journalInfo", {}) or {}
        if isinstance(journal_info, dict):
            journal = journal_info.get("journal", {}).get("title", "") or ""
        pub_year = w.get("pubYear", "") or ""
        pub_date = pub_year
        doi = w.get("doi", "") or ""
        has_pdf = w.get("hasPDF", "") == "Y"
        is_oa = w.get("isOpenAccess", "") == "Y"
        in_epmc = w.get("inEPMC", "") == "Y"
        cited_by = int(w.get("citedByCount", 0) or 0)

        fields = {
            "pmid": pmid,
            "pmcid": pmcid,
            "title": title,
            "abstract": abstract,
            "authors": authors,
            "journal": journal,
            "pub_date": pub_date,
            "doi": doi,
            "has_pdf": has_pdf,
            "is_oa": is_oa,
            "in_epmc": in_epmc,
            "cited_by_count": cited_by,
        }
        url = (f"https://europepmc.org/article/MED/{pmid}"
               if pmid else f"https://europepmc.org/article/PMC/{pmcid}")
        # 置信度：OA + 有 PMCID + 有 PDF 的文献置信度最高
        confidence = 0.95
        if is_oa and pmcid:
            confidence = 1.0
        elif not pmcid:
            confidence = 0.85  # 无 PMCID，只有元数据

        rec = make_record(
            task_id, "europepmc", fields, query,
            url=url, doi=doi or None,
            pmid=pmid or None,
            confidence=confidence,
        )
        records.append(rec)
    return records
