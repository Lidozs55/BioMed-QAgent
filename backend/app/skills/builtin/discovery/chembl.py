"""ChEMBL discovery skill — search the ChEMBL bioactivity database (Agent-only).

ChEMBL (https://www.ebi.ac.uk/chembl) is an Agent-only research source (B4):
its ``SourceCapability`` is ``RESEARCH_ONLY``, so findings from this skill
may inform investigation but must never be routed into a dataset build as a
verified source — the spec validator rejects any build binding whose source
resolves to ``chembl`` (``source_not_pipeline_supported``).

The tool queries the ChEMBL REST API (``https://www.ebi.ac.uk/chembl/api/data``)
and, on failure, falls back to the rendered search page via the crawler
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

_CHEMBL_API_BASE = "https://www.ebi.ac.uk/chembl/api/data"
_CHEMBL_PAGE_BASE = "https://www.ebi.ac.uk/chembl/g"
_MAX_BODY_CHARS = 5000


def _accept_chembl_search_result(result: FetchResult) -> bool:
    if result.method_used == "api":
        try:
            document = json.loads(result.content)
        except (json.JSONDecodeError, TypeError):
            return False
        return isinstance(document, dict) and isinstance(
            document.get("molecules"), list
        )
    return bool(result.content)


@function_tool
async def search_chembl(
    ctx: RunContextWrapper[Any],
    query: str,
    max_results: int = 20,
) -> str:
    """Search ChEMBL for molecules matching a keyword.

    Queries the ChEMBL REST API first; falls back to the rendered search page
    when the API is unavailable or returns an unexpected shape.

    Args:
        ctx: Agent SDK run context wrapper.
        query: Search keyword (e.g. "aspirin", "EGFR inhibitor", "kinase").
        max_results: Maximum number of molecule records to return (default 20).

    Returns:
        JSON string with keys: source, query, count, records, method_used,
        attempts. On page fallback: JSON with status="page_fallback". On
        failure: JSON with status="error" and the attempted methods.
    """
    run_ctx: RunContext = ctx.context
    api_url = (
        f"{_CHEMBL_API_BASE}/molecule/search?q={quote(query)}"
        f"&limit={max_results}&format=json"
    )
    page_url = (
        f"{_CHEMBL_PAGE_BASE}/#search_results/all/query/{quote(query)}"
    )
    try:
        result = await fetch_with_fallback(
            api_url,
            page_url,
            source_name="chembl",
            accept_result=_accept_chembl_search_result,
            facade=run_ctx.crawler_facade,
        )
    except CrawlError as exc:
        run_ctx.log_query(query, "chembl", QueryStatus.FAILED, 0)
        return json.dumps(
            {
                "source": "chembl",
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
        molecules = data.get("molecules", [])[:max_results]
        records: list[dict[str, Any]] = []
        for molecule in molecules:
            chembl_id = molecule.get("molecule_chembl_id", "")
            records.append(
                {
                    "chembl_id": chembl_id,
                    "preferred_name": molecule.get("pref_name"),
                    "molecule_type": molecule.get("molecule_type"),
                    "max_phase": molecule.get("max_phase"),
                    "url": (
                        f"https://www.ebi.ac.uk/chembl/compound_report_card/"
                        f"{chembl_id}"
                    ),
                }
            )
        run_ctx.log_query(query, "chembl", QueryStatus.SUCCESS, len(records))
        return json.dumps(
            {
                "source": "chembl",
                "query": query,
                "count": len(records),
                "total_count": data.get("page_meta", {}).get("total_count", len(records)),
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
                    "ChEMBL 是 Agent-only 研究来源（research_only）：检索结果可用于"
                    "调研与证据收集，但绝不能作为 DatasetBuildSpec 的 verified "
                    "source 进入数据构建——spec 校验会拒绝（source_not_pipeline_supported）。"
                ),
            },
            ensure_ascii=False,
        )
    run_ctx.log_query(query, "chembl", QueryStatus.SUCCESS, 0)
    return json.dumps(
        {
            "source": "chembl",
            "query": query,
            "status": "page_fallback",
            "page_url": page_url,
            "method_used": result.method_used,
            "body_preview": result.content[:_MAX_BODY_CHARS],
        },
        ensure_ascii=False,
    )


SKILL_NAME = 'chembl'
SKILL_CATEGORY = SkillCategory.DISCOVERY
SKILL_DESCRIPTION = (
    'Search the ChEMBL database for molecules (ChEMBL id, preferred name, molecule type, max'
    'phase). Agent-only research source — findings must not be routed into dataset builds.'
)
SKILL_VERSION = '0.1.0'
SUPPORTED_SOURCES = ['chembl']
SKILL_TOOLS = [
    search_chembl,
]
