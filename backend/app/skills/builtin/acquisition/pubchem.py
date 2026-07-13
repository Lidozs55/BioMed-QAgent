"""PubChem acquisition skill — search and fetch compound data.

PubChem is the NIH database of chemical molecules and their activities.
This skill uses the three-tier fallback chain (api > httpx > crawl):

    1. API first: PUG-REST API (structured JSON/CSV)
    2. httpx second: direct page fetch with browser UA
    3. crawl fallback: return requires_crawl signal for Playwright

PUG-REST API docs: https://pubchem.ncbi.nlm.nih.gov/docs/pug-rest
"""
from __future__ import annotations

import json
import logging
from typing import Any
from urllib.parse import quote

from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext
from app.domain.output import SourceRecord
from app.skills.registry import SkillCategory, SkillDef, skill_registry
from app.tools.crawler import api_fetch, httpx_fetch
from app.tools.crawl_signal import requires_crawl_json

logger = logging.getLogger(__name__)

_PUGREST_BASE = "https://pubchem.ncbi.nlm.nih.gov/rest/pug"
_PUBCHEM_PAGE_BASE = "https://pubchem.ncbi.nlm.nih.gov/compound"


@function_tool
def search_pubchem(
    ctx: RunContextWrapper[Any],
    term: str,
    max_results: int = 20,
) -> str:
    """Search PubChem for chemical compounds matching a name or keyword.

    Queries the PUG-REST API (tier 1). If the API is unavailable, falls back
    to httpx page fetch (tier 2). If both fail, returns a ``requires_crawl``
    signal so the agent can use Playwright.

    Args:
        ctx: Agent SDK run context wrapper.
        term: Compound name or keyword (e.g. "aspirin", "curcumin").
        max_results: Maximum number of compounds to return (default 20).

    Returns:
        JSON string with keys: source, term, count, records.
        On failure: JSON with status="requires_crawl".
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
        except (json.JSONDecodeError, KeyError) as exc:
            logger.warning("Failed to parse PubChem API response: %s", exc)

    # Tier 2: httpx
    page_url = f"https://pubchem.ncbi.nlm.nih.gov/#query={encoded_term}"
    page_result = httpx_fetch(page_url)
    if page_result.ok:
        run_ctx.log_query(term, "pubchem", "ok", 0)
        return json.dumps({
            "source": "pubchem",
            "term": term,
            "count": 0,
            "records": [],
            "method_used": "httpx",
            "note": "API unavailable; page fetched but requires JS rendering",
            "page_url": page_url,
        }, ensure_ascii=False)

    # Tier 3: requires_crawl (PubChem is JS-heavy, often needs Playwright)
    run_ctx.log_query(term, "pubchem", "error", 0)
    return requires_crawl_json(
        source="pubchem",
        reason=f"PubChem API and httpx both failed: api={result.error or result.status_code}, httpx={page_result.error or page_result.status_code}",
        tried_methods=["api", "httpx"],
        target_url=page_url,
    )


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
        On failure: JSON with status="requires_crawl".
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
                    source="pubchem",
                    accession=str(cid),
                    source_url=api_url,
                    local_files=[],
                    format_hint="pubchem_json",
                )
                run_ctx.add_source(source_record)

                return json.dumps({
                    "source": "pubchem",
                    "cid": cid,
                    "record": record,
                    "method_used": "api",
                }, ensure_ascii=False)
        except (json.JSONDecodeError, KeyError) as exc:
            logger.warning("Failed to parse PubChem compound response: %s", exc)

    # Tier 2: httpx
    page_url = f"{_PUBCHEM_PAGE_BASE}/{cid}"
    page_result = httpx_fetch(page_url)
    if page_result.ok:
        run_ctx.log_query(str(cid), "pubchem", "ok", 1)
        return json.dumps({
            "source": "pubchem",
            "cid": cid,
            "method_used": "httpx",
            "page_url": page_url,
            "note": "API unavailable; page fetched but requires JS rendering",
        }, ensure_ascii=False)

    # Tier 3: requires_crawl
    run_ctx.log_query(str(cid), "pubchem", "error", 0)
    return requires_crawl_json(
        source="pubchem",
        reason=f"PubChem compound API and httpx both failed for CID {cid}",
        tried_methods=["api", "httpx"],
        target_url=page_url,
    )


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
        "(e.g. 2244 for aspirin). If a requires_crawl signal is returned, "
        "use the browser skill's navigate_page tool to fetch the page with Playwright."
    ),
    tools=[search_pubchem, get_compound],
    supported_sources=["pubchem"],
    version="0.1.0",
)

skill_registry.register(pubchem_skill)
