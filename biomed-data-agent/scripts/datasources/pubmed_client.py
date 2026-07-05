"""PubMed 文献检索客户端。

API: NCBI E-utilities (esearch + efetch)
端点: https://eutils.ncbi.nlm.nih.gov/entrez/eutils/
限速: 1 req/sec（NCBI 无 key 允许 3 req/sec，保守取 1）

用法:
    python scripts/datasources/pubmed_client.py --query "pancreatic cancer" --max 20 --out result.json
"""
from __future__ import annotations

import sys
import xml.etree.ElementTree as ET

import requests

from _base import (
    PUBMED_EUTILS,
    RateLimiter,
    emit_error,
    log_stderr,
    make_record,
    setup_cli,
    write_output,
)

ESEARCH_URL = f"{PUBMED_EUTILS}/esearch.fcgi"
EFETCH_URL = f"{PUBMED_EUTILS}/efetch.fcgi"
HEADERS = {"User-Agent": "BioMedQAgent/1.0"}


def _text(node, tag: str) -> str:
    el = node.find(tag)
    return el.text.strip() if el is not None and el.text else ""


def search_pubmed(query: str, max_results: int, task_id: str) -> list[dict]:
    limiter = RateLimiter(1.0)
    # 1. esearch 获取 PMID 列表
    limiter.wait()
    params = {"db": "pubmed", "term": query, "retmax": max_results, "retmode": "json"}
    r = requests.get(ESEARCH_URL, params=params, headers=HEADERS, timeout=30)
    r.raise_for_status()
    id_list = r.json().get("esearchresult", {}).get("idlist", [])
    if not id_list:
        return []
    # 2. efetch 获取文献详情（XML）
    limiter.wait()
    params = {"db": "pubmed", "id": ",".join(id_list), "retmode": "xml"}
    r = requests.get(EFETCH_URL, params=params, headers=HEADERS, timeout=60)
    r.raise_for_status()
    root = ET.fromstring(r.content)
    records = []
    for art in root.findall(".//PubmedArticle"):
        pmid = _text(art, ".//PMID")
        title = _text(art, ".//ArticleTitle")
        abstract_parts = [a.text for a in art.findall(".//Abstract/AbstractText") if a.text]
        abstract = " ".join(abstract_parts)
        authors = []
        for au in art.findall(".//Author"):
            ln = _text(au, "LastName")
            fn = _text(au, "ForeName")
            if ln:
                authors.append(f"{fn} {ln}".strip())
        journal = _text(art, ".//Journal/Title")
        pub_date = ""
        pd = art.find(".//PubDate")
        if pd is not None:
            y = _text(pd, "Year")
            m = _text(pd, "Month")
            pub_date = "-".join([x for x in [y, m] if x])
        doi = ""
        for aid in art.findall(".//ArticleId"):
            if aid.get("IdType") == "doi":
                doi = (aid.text or "").strip()
                break
        fields = {
            "pmid": pmid,
            "title": title,
            "abstract": abstract,
            "authors": authors,
            "journal": journal,
            "pub_date": pub_date,
            "doi": doi,
        }
        url = f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/" if pmid else None
        rec = make_record(
            task_id, "pubmed", fields, query,
            url=url, doi=doi or None, pmid=pmid or None, confidence=1.0,
        )
        records.append(rec)
    return records


def main() -> None:
    parser = setup_cli("pubmed_client", "PubMed 文献检索（NCBI E-utilities）")
    args = parser.parse_args()
    if not args.query:
        emit_error("缺少 --query 参数")
        sys.exit(1)
    try:
        records = search_pubmed(args.query, args.max, args.task_id)
        write_output(records, args.out)
        log_stderr(f"pubmed: 返回 {len(records)} 条")
    except Exception as e:
        emit_error(f"pubmed 检索失败: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
