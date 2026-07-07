"""arXiv 论文检索客户端。

arXiv 是开放预印本仓库，覆盖物理/数学/计算机/定量生物/统计等领域。
对生物医学研究而言，arXiv 的 q-bio（定量生物）子分类特别有用，
可补充 PubMed/OpenAlex 缺失的预印本和计算生物学论文。

API: http://export.arxiv.org/api/query（Atom XML）
限速: arXiv 建议 3 秒/次（保守取 3）
无需 API Key

作为模块使用：
    from app.tools.datasources.arxiv import search_arxiv
    records = search_arxiv("pancreatic cancer", 20, "task-1")
"""
from __future__ import annotations

import xml.etree.ElementTree as ET

import requests

from .base_ds import (
    RateLimiter,
    make_record,
)

ARXIV_URL = "http://export.arxiv.org/api/query"
ATOM_NS = "{http://www.w3.org/2005/Atom}"
HEADERS = {"User-Agent": "BioMedQAgent/1.0"}


def _text(node, tag: str) -> str:
    """安全提取子节点文本（带命名空间）。"""
    el = node.find(f"{ATOM_NS}{tag}")
    return el.text.strip() if el is not None and el.text else ""


def _authors(node) -> list[str]:
    """提取作者列表。"""
    authors = []
    for au in node.findall(f"{ATOM_NS}author"):
        name = _text(au, "name")
        if name:
            authors.append(name)
    return authors


def _categories(node) -> list[str]:
    """提取 arXiv 分类标签。"""
    cats = []
    for cat in node.findall(f"{ATOM_NS}category"):
        term = cat.get("term", "")
        if term:
            cats.append(term)
    return cats


def _links(node) -> dict[str, str]:
    """提取相关链接（abs/pdf/doi）。"""
    links = {"abs_url": "", "pdf_url": "", "doi": ""}
    for link in node.findall(f"{ATOM_NS}link"):
        rel = link.get("rel", "")
        href = link.get("href", "")
        title = link.get("title", "")
        if rel == "alternate":
            links["abs_url"] = href
        elif title == "pdf" or href.endswith(".pdf"):
            links["pdf_url"] = href
        elif title == "doi":
            links["doi"] = href.replace("http://dx.doi.org/", "")
    return links


def search_arxiv(query: str, max_results: int, task_id: str) -> list[dict]:
    """检索 arXiv，返回 DataRecord 列表。"""
    limiter = RateLimiter(3.0)  # arXiv 要求间隔 >=3s
    limiter.wait()

    params = {
        "search_query": f"all:{query}",
        "start": 0,
        "max_results": max_results,
        "sortBy": "relevance",
        "sortOrder": "descending",
    }
    r = requests.get(ARXIV_URL, params=params, headers=HEADERS, timeout=30)
    r.raise_for_status()

    root = ET.fromstring(r.content)
    entries = root.findall(f"{ATOM_NS}entry")
    records = []
    for entry in entries:
        arxiv_id = _text(entry, "id").split("/abs/")[-1]
        if not arxiv_id:
            continue
        # 去除版本号后缀（如 2101.00001v1 -> 2101.00001）
        base_id = arxiv_id.split("v")[0] if "v" in arxiv_id[-2:] else arxiv_id

        title = _text(entry, "title").replace("\n", " ").strip()
        summary = _text(entry, "summary").replace("\n", " ").strip()
        published = _text(entry, "published")[:10]  # YYYY-MM-DD
        updated = _text(entry, "updated")[:10]
        authors = _authors(entry)
        cats = _categories(entry)
        links = _links(entry)
        doi = links["doi"]

        fields = {
            "arxiv_id": base_id,
            "arxiv_id_versioned": arxiv_id,
            "title": title,
            "abstract": summary,
            "authors": authors,
            "categories": cats,
            "primary_category": cats[0] if cats else "",
            "pub_date": published,
            "updated_date": updated,
            "pdf_url": links["pdf_url"],
            "abs_url": links["abs_url"],
            "doi": doi,
        }
        url = links["abs_url"] or f"https://arxiv.org/abs/{base_id}"
        rec = make_record(
            task_id, "arxiv", fields, query,
            url=url, doi=doi or None, confidence=0.9,
        )
        records.append(rec)
    return records
