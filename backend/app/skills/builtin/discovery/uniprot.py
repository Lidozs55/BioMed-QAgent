"""UniProt discovery skill — search the UniProt knowledgebase (Agent-only).

UniProt (https://www.uniprot.org) is an Agent-only research source (B4):
its ``SourceCapability`` is ``RESEARCH_ONLY``, so findings from this skill
may inform investigation but must never be routed into a dataset build as a
verified source — the spec validator rejects any build binding whose source
resolves to ``uniprot`` (``source_not_pipeline_supported``).

The tool queries the UniProt REST API (``https://rest.uniprot.org``) and, on
failure, falls back to a rendered knowledgebase search page via the crawler
facade (same three-tier fallback chain as the PubChem/Reactome skills).
"""

from __future__ import annotations

import json
import logging
from typing import Any
from urllib.parse import quote

from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext
from app.domain.contracts import QueryStatus
from app.skills.categories import SkillCategory
from app.tools.crawler import CrawlError, FetchResult, fetch_with_fallback

logger = logging.getLogger(__name__)

_UNIPROT_API_BASE = "https://rest.uniprot.org/uniprotkb"
_UNIPROT_PAGE_BASE = "https://www.uniprot.org/uniprotkb"
_MAX_BODY_CHARS = 5000


def _accept_uniprot_search_result(result: FetchResult) -> bool:
    if result.method_used == "api":
        try:
            document = json.loads(result.content)
        except (json.JSONDecodeError, TypeError):
            return False
        return isinstance(document, dict) and isinstance(
            document.get("results"), list
        )
    return bool(result.content)


def _protein_name(entry: dict[str, Any]) -> str:
    description = entry.get("proteinDescription") or {}
    recommended = description.get("recommendedName") or {}
    full_name = recommended.get("fullName") or {}
    value = full_name.get("value")
    return value if isinstance(value, str) else ""


def _organism_name(entry: dict[str, Any]) -> str:
    organism = entry.get("organism") or {}
    return organism.get("scientificName", "")


def _gene_name(entry: dict[str, Any]) -> str:
    genes = entry.get("genes")
    if not isinstance(genes, list) or not genes:
        return ""
    first = genes[0] if isinstance(genes[0], dict) else {}
    gene_name = first.get("geneName") or {}
    value = gene_name.get("value")
    return value if isinstance(value, str) else ""


@function_tool
async def search_uniprot(
    ctx: RunContextWrapper[Any],
    query: str,
    max_results: int = 20,
) -> str:
    """Search the UniProt knowledgebase for proteins matching a keyword.

    Queries the UniProt REST API first; falls back to the rendered search
    page when the API is unavailable or returns an unexpected shape.

    Args:
        ctx: Agent SDK run context wrapper.
        query: Search keyword (e.g. "TP53", "BRCA1", "kinase inhibitor").
        max_results: Maximum number of protein records to return (default 20).

    Returns:
        JSON string with keys: source, query, count, records, method_used,
        attempts. On page fallback: JSON with status="page_fallback". On
        failure: JSON with status="error" and the attempted methods.
    """
    run_ctx: RunContext = ctx.context
    api_url = (
        f"{_UNIPROT_API_BASE}/search?query={quote(query)}"
        f"&format=json&size={max_results}"
    )
    page_url = f"{_UNIPROT_PAGE_BASE}?query={quote(query)}"
    try:
        result = await fetch_with_fallback(
            api_url,
            page_url,
            source_name="uniprot",
            accept_result=_accept_uniprot_search_result,
            facade=run_ctx.crawler_facade,
        )
    except CrawlError as exc:
        run_ctx.log_query(query, "uniprot", QueryStatus.FAILED, 0)
        return json.dumps(
            {
                "source": "uniprot",
                "query": query,
                "status": "error",
                "error": str(exc),
            },
            ensure_ascii=False,
        )
    if result.method_used == "api":
        try:
            data = json.loads(result.content)
        except (json.JSONDecodeError, TypeError):
            data = {}
        entries = data.get("results", [])[:max_results]
        records: list[dict[str, Any]] = []
        for entry in entries:
            accession = entry.get("primaryAccession", "")
            records.append(
                {
                    "accession": accession,
                    "protein_name": _protein_name(entry),
                    "gene": _gene_name(entry),
                    "organism": _organism_name(entry),
                    "reviewed": entry.get("reviewed", False),
                    "url": f"https://www.uniprot.org/uniprotkb/{accession}",
                }
            )
        run_ctx.log_query(query, "uniprot", QueryStatus.SUCCESS, len(records))
        return json.dumps(
            {
                "source": "uniprot",
                "query": query,
                "count": len(records),
                "total_count": data.get("totalResults", len(records)),
                "records": records,
                "method_used": "api",
                "attempts": [
                    {
                        "method": attempt.method,
                        "url": attempt.url,
                        "status": attempt.status,
                        "status_code": attempt.status_code,
                    }
                    for attempt in result.attempts
                ],
                "usage_hint": (
                    "UniProt 是 Agent-only 研究来源（research_only）：检索结果可用于"
                    "调研与证据收集，但绝不能作为 DatasetBuildSpec 的 verified "
                    "source 进入数据构建——spec 校验会拒绝（source_not_pipeline_supported）。"
                ),
            },
            ensure_ascii=False,
        )
    run_ctx.log_query(query, "uniprot", QueryStatus.SUCCESS, 0)
    return json.dumps(
        {
            "source": "uniprot",
            "query": query,
            "status": "page_fallback",
            "page_url": page_url,
            "method_used": result.method_used,
            "body_preview": result.content[:_MAX_BODY_CHARS],
        },
        ensure_ascii=False,
    )


SKILL_NAME = 'uniprot'
SKILL_CATEGORY = SkillCategory.DISCOVERY
SKILL_DESCRIPTION = (
    'Search the UniProt knowledgebase for protein entries (accession, protein name, gene,'
    'organism). Agent-only research source — findings must not be routed into dataset builds.'
)
SKILL_VERSION = '0.1.0'
SUPPORTED_SOURCES = ['uniprot']
SKILL_TOOLS = [
    search_uniprot,
]
