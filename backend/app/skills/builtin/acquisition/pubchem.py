"""PubChem acquisition skill — search and fetch compound data.

PubChem is the NIH database of chemical molecules and their activities.
This skill uses the three-tier fallback chain (api > httpx > crawl):

    1. API first: PUG-REST API (structured JSON/CSV)
    2. httpx second: direct page fetch with browser UA
    3. crawl fallback: Playwright-rendered visible page text

PUG-REST API docs: https://pubchem.ncbi.nlm.nih.gov/docs/pug-rest
"""
from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote

from agents import RunContextWrapper, function_tool
from bs4 import BeautifulSoup

from app.agent_loop.context import RunContext
from app.domain.contracts import Database, SourceRecord, make_source_id
from app.skills.registry import SkillCategory, SkillDef, skill_registry
from app.tools.crawler import CrawlError, FetchResult, api_fetch, fetch_with_fallback

logger = logging.getLogger(__name__)

_PUGREST_BASE = "https://pubchem.ncbi.nlm.nih.gov/rest/pug"
_PUBCHEM_PAGE_BASE = "https://pubchem.ncbi.nlm.nih.gov/compound"
_MAX_BODY_CHARS = 5000


def _visible_text(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "head", "noscript"]):
        tag.decompose()
    return " ".join(soup.get_text(separator=" ", strip=True).split())


def _accept_pubchem_page(result: FetchResult) -> bool:
    return result.method_used == "crawl" and bool(_visible_text(result.content))


def _page_fallback(source: str, page_url: str, result: FetchResult) -> str:
    return json.dumps({
        "status": "page_fallback",
        "source": source,
        "method_used": result.method_used,
        "page_url": page_url,
        "body_text_preview": _visible_text(result.content)[:_MAX_BODY_CHARS],
    }, ensure_ascii=False)


def _fallback_error(source: str, page_url: str, error: CrawlError) -> str:
    return json.dumps({
        "status": "error",
        "source": source,
        "page_url": page_url,
        "attempted_methods": ["api", "httpx", "crawl"],
        "error": str(error),
    }, ensure_ascii=False)


@function_tool
def search_pubchem(
    ctx: RunContextWrapper[Any],
    term: str,
    max_results: int = 20,
) -> str:
    """Search PubChem for chemical compounds matching a name or keyword.

    Queries the PUG-REST API first. If the API is unavailable or cannot be
    parsed, rejects the static shell and uses Playwright-rendered page text.

    Args:
        ctx: Agent SDK run context wrapper.
        term: Compound name or keyword (e.g. "aspirin", "curcumin").
        max_results: Maximum number of compounds to return (default 20).

    Returns:
        JSON string with keys: source, term, count, records.
        On page fallback: JSON with status="page_fallback".
        On failure: JSON with status="error" and attempted methods.
    """
    run_ctx: RunContext = ctx.context
    encoded_term = quote(term)

    # PUG-REST: /compound/name/{name}/property/.../JSON
    api_url = (
        f"{_PUGREST_BASE}/compound/name/{encoded_term}/property/"
        f"MolecularFormula,MolecularWeight,IUPACName,CanonicalSMILES/"
        f"JSON?MaxRecords={max_results}"
    )

    # Tier 1: API
    result = api_fetch(api_url)
    if result.ok:
        try:
            data = json.loads(result.content)
            compounds = data.get("PropertyTable", {}).get("Properties", [])
            records = [
                {
                    "cid": c.get("CID", 0),
                    "molecular_formula": c.get("MolecularFormula", ""),
                    "molecular_weight": c.get("MolecularWeight", 0.0),
                    "iupac_name": c.get("IUPACName", ""),
                    "canonical_smiles": c.get("CanonicalSMILES", ""),
                    "url": f"{_PUBCHEM_PAGE_BASE}/{c.get('CID', '')}",
                }
                for c in compounds
            ]
            run_ctx.log_query(term, "pubchem", "ok", len(records))
            return json.dumps({
                "source": "pubchem",
                "term": term,
                "count": len(records),
                "records": records,
                "method_used": "api",
            }, ensure_ascii=False)
        except (json.JSONDecodeError, AttributeError, KeyError, TypeError) as exc:
            logger.warning("Failed to parse PubChem API response: %s", exc)

    # Direct page fallback: PubChem requires rendered browser content.
    page_url = f"https://pubchem.ncbi.nlm.nih.gov/#query={encoded_term}"
    try:
        page_result = fetch_with_fallback(
            None,
            page_url,
            source_name="pubchem",
            accept_result=_accept_pubchem_page,
        )
        # Page fallback returns only a visible-text preview, not structured
        # records — log honestly so query_log/metrics don't overstate success.
        # See docs/REVIEW_2026-07-18.md §17.3 item 2.
        run_ctx.log_query(term, "pubchem", "page_fallback", 0)
        return _page_fallback("pubchem", page_url, page_result)
    except CrawlError as exc:
        run_ctx.log_query(term, "pubchem", "error", 0)
        return _fallback_error("pubchem", page_url, exc)


@function_tool
def get_compound(
    ctx: RunContextWrapper[Any],
    cid: int,
) -> str:
    """Get detailed information about a specific PubChem compound by CID.

    Queries the PUG-REST API for compound properties including molecular
    formula, weight, IUPAC name, SMILES, and InChI key.

    Args:
        ctx: Agent SDK run context wrapper.
        cid: PubChem Compound ID (e.g. 2244 for aspirin).

    Returns:
        JSON string with compound details.
        On page fallback: JSON with status="page_fallback".
        On failure: JSON with status="error" and attempted methods.
    """
    run_ctx: RunContext = ctx.context
    api_url = (
        f"{_PUGREST_BASE}/compound/cid/{cid}/property/"
        f"MolecularFormula,MolecularWeight,IUPACName,CanonicalSMILES,InChIKey,InChI/"
        f"JSON"
    )

    # Tier 1: API
    result = api_fetch(api_url)
    if result.ok:
        try:
            data = json.loads(result.content)
            compounds = data.get("PropertyTable", {}).get("Properties", [])
            if compounds:
                c = compounds[0]
                record = {
                    "cid": c.get("CID", cid),
                    "molecular_formula": c.get("MolecularFormula", ""),
                    "molecular_weight": c.get("MolecularWeight", 0.0),
                    "iupac_name": c.get("IUPACName", ""),
                    "canonical_smiles": c.get("CanonicalSMILES", ""),
                    "inchi_key": c.get("InChIKey", ""),
                    "inchi": c.get("InChI", ""),
                    "url": f"{_PUBCHEM_PAGE_BASE}/{cid}",
                }
                run_ctx.log_query(str(cid), "pubchem", "ok", 1)

                source_record = SourceRecord(
                    source_id=make_source_id(Database.PUBCHEM, str(cid), api_url),
                    database=Database.PUBCHEM,
                    accession=str(cid),
                    url=api_url,
                    title=f"PubChem compound {cid}",
                    retrieved_at=datetime.now(UTC),
                )
                run_ctx.add_source(source_record)

                return json.dumps({
                    "source": "pubchem",
                    "cid": cid,
                    "record": record,
                    "method_used": "api",
                }, ensure_ascii=False)
        except (json.JSONDecodeError, AttributeError, KeyError, TypeError) as exc:
            logger.warning("Failed to parse PubChem compound response: %s", exc)

    # Direct rendered page fallback.
    page_url = f"{_PUBCHEM_PAGE_BASE}/{cid}"
    try:
        page_result = fetch_with_fallback(
            None,
            page_url,
            source_name="pubchem",
            accept_result=_accept_pubchem_page,
        )
        # Page fallback returns only a visible-text preview, not structured
        # compound records — log honestly. See docs/REVIEW_2026-07-18.md §17.3.
        run_ctx.log_query(str(cid), "pubchem", "page_fallback", 0)
        return _page_fallback("pubchem", page_url, page_result)
    except CrawlError as exc:
        run_ctx.log_query(str(cid), "pubchem", "error", 0)
        return _fallback_error("pubchem", page_url, exc)


pubchem_skill = SkillDef(
    name="pubchem",
    category=SkillCategory.ACQUISITION,
    description=(
        "Search and fetch chemical compound data from PubChem. "
        "Use when the user asks about compounds, chemical structures, SMILES, "
        "molecular formulas, or needs compound properties by CID."
    ),
    instructions=(
        "Use search_pubchem to find compounds by name (e.g. 'aspirin', 'curcumin'). "
        "Use get_compound to fetch details for a specific compound by CID "
        "(e.g. 2244 for aspirin). API failures automatically use a rendered "
        "page fallback and return a bounded visible-text preview."
    ),
    tools=[search_pubchem, get_compound],
    supported_sources=["pubchem"],
    version="0.1.0",
)

skill_registry.register(pubchem_skill)
