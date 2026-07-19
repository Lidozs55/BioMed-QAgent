"""PubMed discovery skill — search PubMed via Biopython Entrez.

Returns structured JSON records (title, abstract, authors, journal, pub_date,
doi, pmid, pmcid, open_access_status) and logs each query to RunContext.
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from html.parser import HTMLParser
from typing import Any

from agents import RunContextWrapper, function_tool
from Bio import Entrez

from app.agent_loop.context import RunContext
from app.config import settings
from app.domain.contracts import Database, QueryStatus, SourceRecord, StageName, make_source_id
from app.integrations.ncbi.discovery import search_pubmed as discover_pubmed
from app.integrations.ncbi.factory import NcbiServices, open_ncbi_services
from app.skills.registry import SkillCategory, SkillDef, skill_registry

logger = logging.getLogger(__name__)

Entrez.email = settings.ncbi_email


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


async def search_pubmed_adapter(
    run_ctx: RunContext,
    query: str,
    max_results: int,
    *,
    services: NcbiServices,
) -> str:
    """Adapt typed PubMed discovery output to the existing Skill JSON wire shape."""

    try:
        result = await discover_pubmed(services.eutils, query, max_results)
        run_ctx.log_query(
            query=query,
            source="pubmed",
            status=QueryStatus.SUCCESS,
            records_count=len(result.records),
        )
        # Surface mid-stage progress so the frontend can show
        # "PubMed: found N papers (of M total hits)" without waiting for
        # stage_completed. See docs/REVIEW_2026-07-18.md §4.
        await run_ctx.emit_progress(
            stage=StageName.DISCOVERY,
            kind="discovered_records",
            current=len(result.records),
            total=result.total_count,
            detail={"source": "pubmed", "query": query},
        )
        records = [{
            "title": record.title,
            "abstract": record.abstract,
            "authors": "; ".join(record.authors),
            "journal": record.journal,
            "pub_date": (
                record.published_at.isoformat() if record.published_at else ""
            ),
            "doi": record.doi or "",
            "pmid": record.pmid,
            "pmcid": record.pmcid or "",
            "is_open_access": bool(record.pmcid),
            "source_url": record.source_url,
        } for record in result.records]
        return json.dumps(
            {
                "source": "pubmed",
                "query": result.query,
                "query_translation": result.query_translation,
                "total_count": result.total_count,
                "records": records,
            },
            ensure_ascii=False,
        )
    except Exception as exc:
        logger.exception("PubMed search failed for query=%r", query)
        run_ctx.log_query(query, "pubmed", QueryStatus.FAILED, 0)
        return json.dumps({
            "source": "pubmed",
            "query": query,
            "query_translation": "",
            "total_count": 0,
            "records": [],
            "error": str(exc),
        }, ensure_ascii=False)


@function_tool(
    name_override="search_pubmed",
    description_override=(
        "Search PubMed for biomedical literature. Accepts a free-text query "
        "and returns structured JSON records with title, abstract, authors, "
        "journal, publication date, DOI, PMID, PMCID, and open access status."
    ),
)
async def search_pubmed(
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
    async with open_ncbi_services() as services:
        return await search_pubmed_adapter(
            ctx.context, query, max_results, services=services
        )


# ---------------------------------------------------------------------------
# Supplementary material link parser
# ---------------------------------------------------------------------------

class _SupplementaryLinkParser(HTMLParser):
    """Parse PMC article HTML and extract links to supplementary material files.

    Collects all ``<a>`` tags, then filters for URLs that look like
    supplementary downloads: .xlsx, .csv, .tsv, .txt, .zip, .xls, .docx, .pdf
    in a /bin/ path, or whose link text matches supplementary keywords.
    """

    _SUPP_EXTENSIONS: tuple[str, ...] = (
        ".xlsx", ".csv", ".tsv", ".txt", ".zip", ".xls", ".docx", ".pdf",
    )
    _SUPP_KEYWORDS: re.Pattern = re.compile(
        r"supplementary|supplemental|additional\s*file|supporting|"
        r"table\s*s\d|figure\s*s\d|appendix|data\s*file",
        re.IGNORECASE,
    )

    def __init__(self) -> None:
        super().__init__()
        self._links: list[tuple[str, str]] = []
        self._current_href: str | None = None
        self._text_parts: list[str] = []
        self._in_link: bool = False

    # -- parser callbacks ---------------------------------------------------

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "a":
            attrs_dict = dict(attrs)
            href = attrs_dict.get("href", "")
            if href:
                self._current_href = href
                self._text_parts = []
                self._in_link = True

    def handle_data(self, data: str) -> None:
        if self._in_link:
            self._text_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._in_link:
            text = "".join(self._text_parts).strip()
            if self._current_href is not None:
                self._links.append((self._current_href, text))
            self._current_href = None
            self._text_parts = []
            self._in_link = False

    # -- filtering ----------------------------------------------------------

    def _is_supplementary(self, href: str, text: str) -> bool:
        href_lower = href.lower()
        if not any(href_lower.endswith(ext) for ext in self._SUPP_EXTENSIONS):
            return False
        # PMC supplementary files are typically served from /bin/
        if "/bin/" in href:
            return True
        combined = f"{href} {text}".lower()
        return bool(self._SUPP_KEYWORDS.search(combined))

    def get_supplementary_links(self) -> list[tuple[str, str]]:
        """Return (href, text) tuples for links that look supplementary."""
        return [
            (href, text) for href, text in self._links
            if self._is_supplementary(href, text)
        ]


# ---------------------------------------------------------------------------
# download_supplementary tool
# ---------------------------------------------------------------------------

@function_tool(
    name_override="download_supplementary",
    description_override=(
        "Download open-access supplementary materials for a PubMed article "
        "given its PMID. Finds supplementary files (.xlsx, .csv, .tsv, .txt, "
        ".zip, .xls, .docx, .pdf) from the PMC open-access article page, "
        "downloads them to the task work directory, and returns metadata JSON."
    ),
)
def download_supplementary(
    ctx: RunContextWrapper[Any],
    pmid: str,
    max_size_mb: int = 50,
) -> str:
    """Download supplementary materials from PMC for a given PMID.

    Steps
    -----
    1. Efetch PubMed XML -> extract PMCID.
    2. Scrape PMC article page for supplementary file links.
    3. Download each file to ``run_ctx.work_dir.raw/``.
    4. Record a ``SourceRecord`` via ``run_ctx.add_source()``.
    """
    run_ctx: RunContext = ctx.context
    max_size_bytes = max_size_mb * 1024 * 1024

    # ---- 1. Fetch PubMed record & extract PMCID ------------------------------
    try:
        handle = Entrez.efetch(db="pubmed", id=pmid, rettype="xml")
        xml_data = handle.read()
        handle.close()
    except Exception as exc:
        logger.exception("PubMed efetch failed for PMID=%s", pmid)
        return json.dumps({
            "source": "pubmed",
            "accession": pmid,
            "error": f"Failed to fetch PubMed record: {exc}",
        }, ensure_ascii=False)

    root = ET.fromstring(xml_data)
    pmcid = ""
    article_ids = root.find(".//PubmedData/ArticleIdList")
    if article_ids is not None:
        for aid in article_ids.findall("ArticleId"):
            if aid.get("IdType") == "pmc" and aid.text:
                pmcid = aid.text.strip()
                break

    if not pmcid:
        return json.dumps({
            "source": "pubmed",
            "accession": pmid,
            "error": "No PMCID found — article is not in the PMC open-access subset",
        }, ensure_ascii=False)

    # ---- 2. Scrape PMC article page for supplementary links -------------------
    pmc_url = f"https://www.ncbi.nlm.nih.gov/pmc/articles/{pmcid}/"

    try:
        req = urllib.request.Request(
            pmc_url,
            headers={"User-Agent": "BioMed-QAgent/0.1 (biomed-qagent@example.com)"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            html = resp.read().decode("utf-8", errors="replace")
    except Exception as exc:
        logger.exception("Failed to fetch PMC page for PMCID=%s", pmcid)
        return json.dumps({
            "source": "pubmed",
            "accession": pmid,
            "source_url": pmc_url,
            "error": f"Failed to fetch PMC article page: {exc}",
        }, ensure_ascii=False)

    parser = _SupplementaryLinkParser()
    parser.feed(html)
    supp_links = parser.get_supplementary_links()

    if not supp_links:
        return json.dumps({
            "source": "pubmed",
            "accession": pmid,
            "source_url": pmc_url,
            "error": "No supplementary files found on the PMC article page",
        }, ensure_ascii=False)

    # ---- 3. Download each file to raw/ ----------------------------------------
    raw_dir = run_ctx.work_dir.raw
    downloaded: list[str] = []
    errors: list[str] = []

    for link_href, _link_text in supp_links:
        # Resolve relative URLs
        if link_href.startswith("/"):
            file_url = f"https://www.ncbi.nlm.nih.gov{link_href}"
        elif link_href.startswith(("http://", "https://")):
            file_url = link_href
        else:
            file_url = f"https://www.ncbi.nlm.nih.gov/pmc/articles/{pmcid}/{link_href}"

        filename = os.path.basename(link_href.split("?")[0])
        if not filename:
            filename = f"supplementary_{pmcid}_{len(downloaded)}"
        local_path = raw_dir / filename

        try:
            req = urllib.request.Request(
                file_url,
                headers={"User-Agent": "BioMed-QAgent/0.1 (biomed-qagent@example.com)"},
            )
            with urllib.request.urlopen(req, timeout=60) as resp:
                content = resp.read()
                if len(content) > max_size_bytes:
                    errors.append(
                        f"Skipped {filename}: {len(content)} bytes exceeds "
                        f"{max_size_mb} MB limit"
                    )
                    continue
                local_path.write_bytes(content)
                downloaded.append(str(local_path))
            # Brief pause between downloads to be respectful of NCBI servers
            time.sleep(0.5)
        except Exception as exc:
            errors.append(f"Failed to download {filename}: {exc}")

    if not downloaded:
        return json.dumps({
            "source": "pubmed",
            "accession": pmid,
            "source_url": pmc_url,
            "error": "Failed to download any supplementary files",
            "details": errors,
        }, ensure_ascii=False)

    # ---- 4. Track via SourceRecord --------------------------------------------
    retrieved_at = datetime.now(UTC)
    source_record = SourceRecord(
        source_id=make_source_id(Database.PUBMED, pmid, pmc_url),
        database=Database.PUBMED,
        accession=pmid,
        url=pmc_url,
        title=f"PubMed supplementary materials for {pmid}",
        retrieved_at=retrieved_at,
    )
    run_ctx.add_source(source_record)
    for f in downloaded:
        run_ctx.add_raw_asset(f)

    result: dict[str, object] = {
        "source": "pubmed",
        "accession": pmid,
        "source_url": pmc_url,
        "local_files": downloaded,
        "format_hint": "supplementary",
        "retrieved_at": retrieved_at.isoformat(),
    }
    if errors:
        result["warnings"] = errors

    return json.dumps(result, ensure_ascii=False)


pubmed_skill = SkillDef(
    name="pubmed",
    category=SkillCategory.DISCOVERY,
    description=(
        "Search PubMed/NCBI for biomedical literature and download "
        "supplementary materials. Use when the user needs to find research "
        "papers, abstracts, authors, or supplementary data files in the "
        "life sciences domain."
    ),
    instructions=(
        "Use the `search_pubmed` tool to query PubMed with a free-text search "
        "string. The tool returns a JSON payload containing paper records with "
        "title, abstract, authors (semicolon-separated), journal, publication "
        "date, DOI, PMID, PMCID, and an `is_open_access` boolean. "
        "`total_count` reflects PubMed's own hit count (may exceed the number "
        "of returned records due to `max_results`). "
        "Use the `download_supplementary` tool to download supplementary "
        "material files (.xlsx, .csv, .tsv, .txt, .zip, .xls, .docx, .pdf) "
        "for a given PMID from the PMC open-access article page. "
        "On failure, responses include an `error` field."
    ),
    tools=[search_pubmed, download_supplementary],
    supported_sources=["pubmed", "ncbi"],
    version="0.2.0",
)

skill_registry.register(pubmed_skill)
