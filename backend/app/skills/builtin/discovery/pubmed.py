"""PubMed discovery skill — search PubMed via Biopython Entrez.

Returns structured JSON records (title, abstract, authors, journal, pub_date,
doi, pmid, pmcid, open_access_status) and logs each query to RunContext.
"""
from __future__ import annotations

import json
import logging
import xml.etree.ElementTree as ET
from typing import Any

from Bio import Entrez
from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext
from app.skills.registry import SkillCategory, SkillDef, skill_registry

logger = logging.getLogger(__name__)

Entrez.email = "biomed-qagent@example.com"


def _parse_pubmed_record(article: ET.Element) -> dict[str, Any]:
    """Parse a single PubmedArticle XML element into a dict."""
    medline_citation = article.find(".//MedlineCitation")
    article_data = article.find(".//Article")

    title = ""
    if article_data is not None:
        title_el = article_data.find("ArticleTitle")
        if title_el is not None and title_el.text:
            title = title_el.text.strip()

    abstract = ""
    if article_data is not None:
        abstract_el = article_data.find("Abstract")
        if abstract_el is not None:
            texts = [
                t.text.strip()
                for t in abstract_el.findall("AbstractText")
                if t.text
            ]
            abstract = " ".join(texts)

    authors = ""
    if article_data is not None:
        author_list = article_data.find("AuthorList")
        if author_list is not None:
            names: list[str] = []
            for author in author_list.findall("Author"):
                last = author.findtext("LastName", "")
                fore = author.findtext("ForeName", "")
                if last or fore:
                    names.append(f"{fore} {last}".strip())
            authors = "; ".join(names)

    journal = ""
    if article_data is not None:
        journal_el = article_data.find("Journal/Title")
        if journal_el is not None and journal_el.text:
            journal = journal_el.text.strip()

    pub_date = ""
    if medline_citation is not None:
        date_el = medline_citation.find(
            ".//DateRevised/Year"
        )
        if date_el is not None and date_el.text:
            year = date_el.text.strip()
            month_el = medline_citation.find(".//DateRevised/Month")
            month = month_el.text.strip() if month_el is not None and month_el.text else ""
            pub_date = f"{year}-{month}" if month else year

    doi = ""
    pmcid = ""
    pmid = ""
    if medline_citation is not None:
        pmid_el = medline_citation.find("PMID")
        if pmid_el is not None and pmid_el.text:
            pmid = pmid_el.text.strip()

    article_ids = article.find(".//PubmedData/ArticleIdList")
    if article_ids is not None:
        for aid in article_ids.findall("ArticleId"):
            id_type = aid.get("IdType", "")
            if id_type == "doi" and aid.text:
                doi = aid.text.strip()
            elif id_type == "pmc" and aid.text:
                pmcid = aid.text.strip()

    is_open_access = bool(pmcid)

    return {
        "title": title,
        "abstract": abstract,
        "authors": authors,
        "journal": journal,
        "pub_date": pub_date,
        "doi": doi,
        "pmid": pmid,
        "pmcid": pmcid,
        "is_open_access": is_open_access,
    }


@function_tool(
    name_override="search_pubmed",
    description_override=(
        "Search PubMed for biomedical literature. Accepts a free-text query "
        "and returns structured JSON records with title, abstract, authors, "
        "journal, publication date, DOI, PMID, PMCID, and open access status."
    ),
)
def search_pubmed(
    ctx: RunContextWrapper[RunContext],
    query: str,
    max_results: int = 20,
) -> str:
    """Search PubMed via NCBI Entrez and return structured records as JSON.

    Args:
        ctx: Run context (injected by the SDK, not exposed to the LLM).
        query: Free-text search query for PubMed.
        max_results: Maximum number of records to fetch (default 20).
    """
    run_ctx: RunContext = ctx.context

    try:
        handle = Entrez.esearch(
            db="pubmed",
            term=query,
            retmax=max_results,
        )
        search_results = Entrez.read(handle)
        handle.close()

        id_list = search_results.get("IdList", [])
        total_count = int(search_results.get("Count", 0))
        records: list[dict[str, Any]] = []

        if id_list:
            fetch_handle = Entrez.efetch(
                db="pubmed",
                id=",".join(id_list),
                rettype="xml",
            )
            xml_data = fetch_handle.read()
            fetch_handle.close()

            root = ET.fromstring(xml_data)
            articles = root.findall(".//PubmedArticle")
            for article in articles:
                records.append(_parse_pubmed_record(article))

        run_ctx.log_query(
            query=query,
            source="pubmed",
            status="completed",
            records_count=len(records),
        )

        return json.dumps({
            "source": "pubmed",
            "query": query,
            "total_count": total_count,
            "records": records,
        }, ensure_ascii=False)

    except Exception as exc:
        logger.exception("PubMed search failed for query=%r", query)
        run_ctx.log_query(
            query=query,
            source="pubmed",
            status="failed",
            records_count=0,
        )
        return json.dumps({
            "source": "pubmed",
            "query": query,
            "total_count": 0,
            "records": [],
            "error": str(exc),
        }, ensure_ascii=False)


pubmed_skill = SkillDef(
    name="pubmed",
    category=SkillCategory.DISCOVERY,
    description=(
        "Search PubMed/NCBI for biomedical literature. Use when the user "
        "needs to find research papers, abstracts, or authors in the life "
        "sciences domain."
    ),
    instructions=(
        "Use the `search_pubmed` tool to query PubMed with a free-text search "
        "string. The tool returns a JSON payload containing paper records with "
        "title, abstract, authors (semicolon-separated), journal, publication "
        "date, DOI, PMID, PMCID, and an `is_open_access` boolean. "
        "`total_count` reflects PubMed's own hit count (may exceed the number "
        "of returned records due to `max_results`). "
        "On failure, the response includes an `error` field."
    ),
    tools=[search_pubmed],
    supported_sources=["pubmed", "ncbi"],
    version="0.1.0",
)

skill_registry.register(pubmed_skill)
