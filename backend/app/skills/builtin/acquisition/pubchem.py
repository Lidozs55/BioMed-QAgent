"""PubChem acquisition skill — search and fetch compound data.

PubChem is the NIH database of chemical molecules and their activities.
This skill uses the three-tier fallback chain (api > httpx > crawl):

    1. API first: PUG-REST API (structured JSON/CSV)
    2. httpx second: direct page fetch with browser UA
    3. crawl fallback: Playwright-rendered visible page text

PUG-REST API docs: https://pubchem.ncbi.nlm.nih.gov/docs/pug-rest
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote

from agents import RunContextWrapper, function_tool
from bs4 import BeautifulSoup

from app.agent_loop.context import RunContext
from app.domain.contracts import (
    Database,
    DataLevel,
    QueryStatus,
    SourceRecord,
    generate_prefixed_uuid,
    make_source_id,
)
from app.skills.builtin.acquisition._download_io import download_file_for_run
from app.skills.registry import SkillCategory, SkillDef, skill_registry
from app.tools.crawler import CrawlAttempt, CrawlError, FetchResult, fetch_with_fallback

logger = logging.getLogger(__name__)

_PUGREST_BASE = "https://pubchem.ncbi.nlm.nih.gov/rest/pug"
_PUBCHEM_PAGE_BASE = "https://pubchem.ncbi.nlm.nih.gov/compound"
_MAX_BODY_CHARS = 5000


def _visible_text(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "head", "noscript"]):
        tag.decompose()
    return " ".join(soup.get_text(separator=" ", strip=True).split())


def _pubchem_properties(result: FetchResult) -> list[object] | None:
    if result.method_used == "api":
        try:
            data = json.loads(result.content)
        except (json.JSONDecodeError, TypeError):
            return None
        properties = data.get("PropertyTable", {}).get("Properties")
        return properties if isinstance(properties, list) else None
    return None


def _accept_pubchem_search_result(result: FetchResult) -> bool:
    if result.method_used == "api":
        return _pubchem_properties(result) is not None
    return result.method_used == "crawl" and bool(_visible_text(result.content))


def _accept_pubchem_compound_result(result: FetchResult) -> bool:
    if result.method_used == "api":
        return bool(_pubchem_properties(result))
    return result.method_used == "crawl" and bool(_visible_text(result.content))


def _attempt_audit(attempts: tuple[CrawlAttempt, ...]) -> list[dict[str, object]]:
    return [
        {
            "method": attempt.method,
            "url": attempt.url,
            "status": attempt.status,
            "status_code": attempt.status_code,
            "reason": attempt.reason,
            "fallback_reason": attempt.fallback_reason,
        }
        for attempt in attempts
    ]


def _page_fallback(source: str, page_url: str, result: FetchResult) -> str:
    return json.dumps(
        {
            "status": "page_fallback",
            "source": source,
            "method_used": result.method_used,
            "page_url": page_url,
            "body_text_preview": _visible_text(result.content)[:_MAX_BODY_CHARS],
            "attempts": _attempt_audit(result.attempts),
        },
        ensure_ascii=False,
    )


def _fallback_error(source: str, page_url: str, error: CrawlError) -> str:
    return json.dumps(
        {
            "status": "error",
            "source": source,
            "page_url": page_url,
            "attempted_methods": ["api", "httpx", "crawl"],
            "attempts": _attempt_audit(error.attempts),
            "error": str(error),
        },
        ensure_ascii=False,
    )


@function_tool(
    description_override=(
        "Search PubChem for chemical compounds matching a name or keyword. "
        "Parameters: ``term`` (required, search keyword like 'aspirin' or "
        "'caffeine'), ``max_results`` (optional, default 20). "
        "Returns JSON with compound records (CID, name, formula, MW, etc.). "
        "Use ``get_compound`` to get full details for a specific CID."
    ),
)
async def search_pubchem(
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

    page_url = f"https://pubchem.ncbi.nlm.nih.gov/#query={encoded_term}"
    try:
        result = await fetch_with_fallback(
            api_url,
            page_url,
            source_name="pubchem",
            accept_result=_accept_pubchem_search_result,
            facade=run_ctx.crawler_facade,
        )
    except CrawlError as exc:
        run_ctx.log_query(term, "pubchem", QueryStatus.FAILED, 0)
        return _fallback_error("pubchem", page_url, exc)
    if result.method_used == "api":
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
            run_ctx.log_query(term, "pubchem", QueryStatus.SUCCESS, len(records))
            return json.dumps(
                {
                    "source": "pubchem",
                    "term": term,
                    "count": len(records),
                    "records": records,
                    "method_used": "api",
                    "attempts": _attempt_audit(result.attempts),
                },
                ensure_ascii=False,
            )
        except (json.JSONDecodeError, AttributeError, KeyError, TypeError) as exc:
            logger.warning("Failed to parse PubChem API response: %s", exc)
    run_ctx.log_query(term, "pubchem", QueryStatus.PAGE_FALLBACK, 0)
    return _page_fallback("pubchem", page_url, result)


@function_tool
async def get_compound(
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

    page_url = f"{_PUBCHEM_PAGE_BASE}/{cid}"
    try:
        result = await fetch_with_fallback(
            api_url,
            page_url,
            source_name="pubchem",
            accept_result=_accept_pubchem_compound_result,
            facade=run_ctx.crawler_facade,
        )
    except CrawlError as exc:
        run_ctx.log_query(str(cid), "pubchem", QueryStatus.FAILED, 0)
        return _fallback_error("pubchem", page_url, exc)
    if result.method_used == "api":
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
                run_ctx.log_query(str(cid), "pubchem", QueryStatus.SUCCESS, 1)

                source_record = SourceRecord(
                    source_id=make_source_id(Database.PUBCHEM, str(cid), api_url),
                    database=Database.PUBCHEM,
                    accession=str(cid),
                    url=api_url,
                    title=f"PubChem compound {cid}",
                    retrieved_at=datetime.now(UTC),
                )
                run_ctx.add_source(source_record)

                return json.dumps(
                    {
                        "source": "pubchem",
                        "cid": cid,
                        "record": record,
                        "method_used": "api",
                        "attempts": _attempt_audit(result.attempts),
                    },
                    ensure_ascii=False,
                )
        except (json.JSONDecodeError, AttributeError, KeyError, TypeError) as exc:
            logger.warning("Failed to parse PubChem compound response: %s", exc)
    run_ctx.log_query(str(cid), "pubchem", QueryStatus.PAGE_FALLBACK, 0)
    return _page_fallback("pubchem", page_url, result)


@function_tool
async def download_pubchem(
    ctx: RunContextWrapper[Any],
    cid: int,
    file_type: str = "sdf",
) -> str:
    """Download a PubChem compound structure file (SDF or MOL).

    Uses the PUG-REST ``record`` endpoint to fetch the full structure record
    in SDF (2D) or MOL (2D) format. The file is staged as a compliant
    ``SourceAsset`` in managed (subagent) runs and written to the task raw
    directory otherwise, then tracked via a ``SourceRecord`` for provenance.

    Args:
        ctx: Agent SDK run context wrapper.
        cid: PubChem Compound ID (e.g. 2244 for aspirin).
        file_type: ``sdf`` (default) or ``mol``.

    Returns:
        JSON with source, cid, source_url, local_files, format_hint, and
        retrieved_at (ISO-8601); ``error`` on failure.
    """
    run_ctx: RunContext = ctx.context
    file_type = file_type.lower().strip().lstrip(".")
    if file_type not in {"sdf", "mol"}:
        return json.dumps({
            "source": "pubchem",
            "cid": cid,
            "error": f"unsupported file_type: {file_type}. Use 'sdf' or 'mol'.",
        }, ensure_ascii=False)
    record_type = "2d"
    ext = file_type.upper()
    url = f"{_PUGREST_BASE}/compound/cid/{cid}/record/{ext}?record_type={record_type}"
    filename = f"CID{cid}.{file_type}"
    format_hint = f"pubchem_{file_type}"

    try:
        if run_ctx.subagent_id is not None:
            facade = run_ctx.crawler_facade_or_none
            if facade is None:
                raise RuntimeError("crawler facade is not bound to the child Run")
            result = await facade.download(url)
            if not result.ok:
                raise RuntimeError(result.error or f"HTTP {result.status_code}")
            content = result.content
            source_id = make_source_id(Database.PUBCHEM, str(cid), url)
            asset = await asyncio.to_thread(
                run_ctx.stage_source_asset,
                content=content,
                filename=filename,
                source_id=source_id,
                successful_attempt_id=generate_prefixed_uuid("download_attempt"),
                data_level=DataLevel.REPOSITORY_PROCESSED,
                media_type=(
                    "chemical/x-mdl-sdfile"
                    if file_type == "sdf"
                    else "chemical/x-mdl-molfile"
                ),
            )
            dest = run_ctx.source_asset_path(asset)
        else:
            dest = run_ctx.work_dir.raw_file(filename)
            await download_file_for_run(run_ctx, url, dest)
    except Exception as exc:
        return json.dumps({
            "source": "pubchem",
            "cid": cid,
            "source_url": url,
            "error": f"download failed: {exc}",
        }, ensure_ascii=False)

    local_files = [str(dest)]
    run_ctx.add_raw_asset(local_files[0])

    retrieved_at = datetime.now(UTC)
    source_record = SourceRecord(
        source_id=make_source_id(Database.PUBCHEM, str(cid), url),
        database=Database.PUBCHEM,
        accession=str(cid),
        url=url,
        title=f"PubChem compound {cid} {file_type.upper()} structure",
        retrieved_at=retrieved_at,
    )
    run_ctx.add_source(source_record)

    return json.dumps({
        "source": "pubchem",
        "cid": cid,
        "source_url": url,
        "local_files": local_files,
        "format_hint": format_hint,
        "retrieved_at": retrieved_at.isoformat(),
    }, ensure_ascii=False)


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
        "(e.g. 2244 for aspirin). Use download_pubchem to fetch the full SDF/MOL "
        "structure record for a CID. API failures automatically use a rendered "
        "page fallback and return a bounded visible-text preview."
    ),
    tools=[search_pubchem, get_compound, download_pubchem],
    supported_sources=["pubchem"],
    version="0.1.0",
)

skill_registry.register(pubchem_skill)
