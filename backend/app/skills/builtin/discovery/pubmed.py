"""PubMed discovery skill — search PubMed via NCBI E-utilities.

Returns structured JSON records (title, abstract, authors, journal, pub_date,
doi, pmid, pmcid, open_access_status) and logs each query to RunContext.

All NCBI E-utilities calls route through ``NcbiEutilsClient`` (via
``NcbiServices.eutils``), which enforces ``tool`` / ``email`` / ``api_key``
parameters, 3/10 req/s rate limiting, and 429/5xx retry — see
``app/integrations/ncbi/client.py``. PMC page and supplementary file downloads
use ``services.http`` (``httpx.AsyncClient``) with ``BROWSER_HEADERS`` to
satisfy the project_memory L11 real-browser-UA constraint.
"""
from __future__ import annotations

import json
import logging
import os
import re
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from html.parser import HTMLParser
from typing import Any

import httpx
from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext
from app.domain.contracts import (
    Database,
    DataLevel,
    QueryStatus,
    SourceRecord,
    StageName,
    generate_prefixed_uuid,
    make_source_id,
)
from app.integrations.acquisition import acquire_source
from app.integrations.ncbi.discovery import search_pubmed as discover_pubmed
from app.integrations.ncbi.factory import NcbiServices, open_ncbi_services
from app.skills.registry import SkillCategory, SkillDef, skill_registry
from app.tools.crawler import BROWSER_HEADERS

logger = logging.getLogger(__name__)


async def search_pubmed_adapter(
    run_ctx: RunContext,
    query: str,
    max_results: int,
    *,
    services: NcbiServices,
) -> str:
    """Adapt typed PubMed discovery output to the existing Skill JSON wire shape.

    Raises the underlying exception on failure so the Agents SDK marks the
    tool_output as ``is_error=True`` and the frontend ToolCallStep renders the
    error state. Previously the adapter swallowed the exception and returned a
    JSON body with ``error``/``total_count=0``, which caused the SDK to report
    success while the LLM (and user) saw an empty result with no visible error.

    When the original query returns 0 results and looks like a natural-language
    sentence, the adapter automatically tries a simplified query (e.g.
    "METTL5 expression in pancreatic cancer" → "(METTL5) AND pancreatic
    cancer") as a fallback before giving up.
    """

    try:
        result = await discover_pubmed(services.eutils, query, max_results)
    except Exception:
        logger.exception("PubMed search failed for query=%r", query)
        run_ctx.log_query(query, "pubmed", QueryStatus.FAILED, 0)
        raise

    # Auto-fallback: when the raw query returns 0 results and looks like a
    # natural-language sentence, retry with a simplified structured query.
    if not result.records and (
        len(query) > 50 or len(query.split()) > 8
    ):
        from app.integrations.ncbi.query_utils import simplify_ncbi_query

        simplified = simplify_ncbi_query(query)
        if simplified != query:
            logger.info(
                "PubMed raw query yielded 0 results (%r), "
                "retrying with simplified %r",
                query, simplified,
            )
            result = await discover_pubmed(services.eutils, simplified, max_results)

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

    # Build a brief summary at the top of the payload so the LLM can quickly
    # understand the result without restating the full records array. The
    # ``usage_hint`` field tells the LLM how to consume the records (pass to
    # ``analyze_papers``) without restating them as assistant text. See
    # docs/REVIEW_2026-07-20-llm-output-hygiene.md for the design rationale.
    summary_lines = [
        f"找到 {len(records)} 篇相关文献（共 {result.total_count} 篇匹配）"
    ]
    top_titles = [
        record["title"] for record in records[:3] if record.get("title")
    ]
    if top_titles:
        summary_lines.append(f"前 {len(top_titles)} 篇标题：")
        for index, title in enumerate(top_titles, 1):
            summary_lines.append(f"{index}. {title}")
    summary_text = "\n".join(summary_lines)

    return json.dumps(
        {
            "summary": summary_text,
            "source": "pubmed",
            "query": result.query,
            "query_translation": result.query_translation,
            "total_count": result.total_count,
            "records_count": len(records),
            "records": records,
            "usage_hint": (
                "可将 records 中每条记录的 title 字段提取为列表，传给 analyze_papers "
                "工具进行结构化分析（只传 title，不要传 abstract 或完整 records）。"
                "不要在 assistant 文本中复述 records 内容——工具卡片已自动展示。"
            ),
        },
        ensure_ascii=False,
    )


@function_tool(
    name_override="search_pubmed",
    description_override=(
        "Search PubMed for biomedical literature. Returns JSON with a top-level "
        "`summary` field (brief overview + top 3 titles) and a `records` field "
        "(full structured records: title, abstract, authors, journal, pub_date, "
        "doi, pmid, pmcid, is_open_access, source_url). Use the summary to brief "
        "the user. To extract structured clues, pass only the `title` field from "
        "each record (as a list of strings) to `analyze_papers` — do NOT pass "
        "the full records or abstracts. Do NOT restate records in assistant text "
        "— the frontend tool card already displays them."
    ),
)
async def search_pubmed(
    ctx: RunContextWrapper[RunContext],
    query: str,
    max_results: int = 20,
) -> str:
    """Search PubMed via NCBI Entrez and return structured records as JSON.

    The returned JSON has the following shape::

        {
          "summary": "找到 N 篇相关文献（共 M 篇匹配）。前 3 篇标题：...",
          "source": "pubmed",
          "query": "...",
          "query_translation": "...",
          "total_count": 234,
          "records_count": 20,
          "records": [{"title":..., "abstract":..., "authors":...,
                       "journal":..., "pub_date":..., "doi":...,
                       "pmid":..., "pmcid":..., "is_open_access":...,
                       "source_url":...}],
          "usage_hint": "完整记录在 records 字段，可传给 analyze_papers ..."
        }

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

async def download_supplementary_adapter(
    run_ctx: RunContext,
    pmid: str,
    *,
    services: NcbiServices,
    max_size_mb: int = 4096,
) -> str:
    """Download PMC supplementary materials through ``NcbiServices``.

    Routes E-utilities through ``services.eutils`` (``NcbiEutilsClient``) and
    HTTP downloads through ``services.http`` (``httpx.AsyncClient``) with
    ``BROWSER_HEADERS``. This satisfies TODO §1.5 (replace Biopython Entrez
    with the rate-limited, api-key-aware ``NcbiEutilsClient``) and the
    project_memory L11 real-browser-UA constraint.

    Steps
    -----
    1. ``efetch`` PubMed XML via ``services.eutils`` → extract PMCID.
    2. Fetch the PMC article page via ``services.http`` + BROWSER_HEADERS.
    3. Download each supplementary file via ``services.http`` + BROWSER_HEADERS,
       skipping files that exceed ``max_size_mb``.
    4. Record a ``SourceRecord`` via ``run_ctx.add_source()``.
    """
    max_size_bytes = max_size_mb * 1024 * 1024

    # ---- 1. Fetch PubMed record & extract PMCID ------------------------------
    try:
        xml_data = await services.eutils.efetch(
            db="pubmed", ids=[pmid], retmode="xml"
        )
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

    # ---- 2. Register the PubMed efetch XML itself as a SourceAsset ---------
    # The XML is the original record that the PMCID and the supplementary
    # links are derived from; keeping it as a content-addressed asset makes
    # the provenance chain complete (TODO Phase 2.5 P1).
    xml_source_id = make_source_id(
        Database.PUBMED,
        pmid,
        "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi",
    )
    xml_asset = run_ctx.stage_source_asset(
        content=xml_data,
        filename=f"pubmed_{pmid}.xml",
        source_id=xml_source_id,
        successful_attempt_id=generate_prefixed_uuid("download_attempt"),
        data_level=DataLevel.METADATA,
        media_type="application/xml",
    )

    # ---- 3. Fetch PMC article page for supplementary links -------------------
    pmc_url = f"https://www.ncbi.nlm.nih.gov/pmc/articles/{pmcid}/"

    try:
        response = await services.http.get(
            pmc_url,
            headers=BROWSER_HEADERS,
            timeout=30.0,
            follow_redirects=True,
        )
        response.raise_for_status()
        html = response.text
    except httpx.HTTPError as exc:
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
    downloaded: list[str] = []
    errors: list[str] = []
    assets = []
    attempts = []
    retrieved_at = datetime.now(UTC)

    async def _report_progress(bytes_received: int, total: int | None) -> None:
        # Throttle to whole-megabyte steps so large supplementary downloads
        # surface incremental progress without spamming the event stream.
        if bytes_received % (1024 * 1024) < 64 * 1024 or (
            total is not None and bytes_received >= total
        ):
            await run_ctx.emit_progress(
                stage=StageName.ACQUISITION,
                kind="downloaded_bytes",
                current=bytes_received,
                total=total,
                detail={"source": "pubmed", "accession": pmid, "filename": filename},
            )

    source_record = SourceRecord(
        source_id=make_source_id(Database.PUBMED, pmid, pmc_url),
        database=Database.PUBMED,
        accession=pmid,
        url=pmc_url,
        title=f"PubMed supplementary materials for {pmid}",
        retrieved_at=retrieved_at,
    )

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
        file_source = source_record.model_copy(
            update={"url": file_url, "title": f"Supplementary file {filename}"}
        )
        result = await acquire_source(
            source=file_source,
            filename=filename,
            workdir=run_ctx.work_dir,
            cache=services.cache,
            http=services.http,
            data_level=DataLevel.SUBMITTER_PROCESSED,
            max_bytes=max_size_bytes,
            accept="*/*",
            request_headers=BROWSER_HEADERS,
            progress=_report_progress,
        )
        attempts.append(result.attempt)
        if result.asset is None:
            errors.append(
                f"Failed to download {filename}: "
                f"{result.attempt.error_message or result.attempt.error_code}"
            )
            continue
        assets.append(result.asset)
        local_path = run_ctx.work_dir.root / result.asset.relative_path
        downloaded.append(str(local_path))

    if not downloaded:
        return json.dumps({
            "source": "pubmed",
            "accession": pmid,
            "source_url": pmc_url,
            "error": "Failed to download any supplementary files",
            "details": errors,
            "download_attempts": [
                attempt.model_dump(mode="json") for attempt in attempts
            ],
        }, ensure_ascii=False)

    # ---- 4. Track via SourceRecord --------------------------------------------
    run_ctx.add_source(source_record)
    for path, asset in zip(downloaded, assets, strict=True):
        run_ctx.add_raw_asset(path)
        run_ctx.record_source_asset_id(asset.asset_id)

    result: dict[str, object] = {
        "source": "pubmed",
        "accession": pmid,
        "source_url": pmc_url,
        "local_files": downloaded,
        "source_assets": [asset.model_dump(mode="json") for asset in assets],
        "pubmed_xml_asset": xml_asset.model_dump(mode="json"),
        "download_attempts": [
            attempt.model_dump(mode="json") for attempt in attempts
        ],
        "format_hint": "supplementary",
        "retrieved_at": retrieved_at.isoformat(),
    }
    if errors:
        result["warnings"] = errors

    return json.dumps(result, ensure_ascii=False)


@function_tool(
    name_override="download_supplementary",
    description_override=(
        "Download open-access supplementary materials for a PubMed article "
        "given its PMID. Finds supplementary files (.xlsx, .csv, .tsv, .txt, "
        ".zip, .xls, .docx, .pdf) from the PMC open-access article page, "
        "downloads them to the task work directory, and returns metadata JSON."
    ),
)
async def download_supplementary(
    ctx: RunContextWrapper[Any],
    pmid: str,
    max_size_mb: int = 4096,
) -> str:
    """Download supplementary materials from PMC for a given PMID.

    Steps
    -----
    1. Efetch PubMed XML -> extract PMCID.
    2. Scrape PMC article page for supplementary file links.
    3. Download each file to ``run_ctx.work_dir.raw/``.
    4. Record a ``SourceRecord`` via ``run_ctx.add_source()``.
    """
    async with open_ncbi_services() as services:
        return await download_supplementary_adapter(
            ctx.context, pmid, services=services, max_size_mb=max_size_mb
        )


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
