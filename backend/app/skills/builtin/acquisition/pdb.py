"""RCSB PDB acquisition skill — search, describe, and download protein structures."""
from __future__ import annotations

import json
import logging
import shutil
import time
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError

from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext
from app.domain.contracts import Database, SourceRecord, make_source_id
from app.skills.registry import SkillCategory, SkillDef, skill_registry

logger = logging.getLogger(__name__)

_SEARCH_API = "https://search.rcsb.org/rcsbsearch/v2/query"
_DATA_API = "https://data.rcsb.org/rest/v1/core/entry/"
_FILES_BASE = "https://files.rcsb.org/download/"

#: 浏览器 User-Agent，避免被反爬识别（AGENTS.md 硬约束）。
_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)

#: 每次外部请求间隔（AGENTS.md 硬约束：2s per request）。
_RATE_LIMIT_SECONDS = 2.0

#: search_pdb 内部对前 N 条结果补全详情，避免 N+1 查询阻塞 agent loop。
_DESCRIBE_BATCH_LIMIT = 3

_last_request_ts: float = 0.0


def _rate_limit() -> None:
    """Sleep so that two consecutive PDB API calls are at least 2s apart."""
    global _last_request_ts
    now = time.monotonic()
    wait = _RATE_LIMIT_SECONDS - (now - _last_request_ts)
    if wait > 0:
        time.sleep(wait)
    _last_request_ts = time.monotonic()


def _post_json(url: str, body: dict) -> dict:
    """POST JSON body and return parsed response."""
    _rate_limit()
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": _USER_AGENT,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def _get_json(url: str) -> dict:
    """GET JSON from a URL with browser User-Agent."""
    _rate_limit()
    req = urllib.request.Request(
        url,
        headers={"User-Agent": _USER_AGENT, "Accept": "application/json"},
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def _download(url: str, dest: Path) -> None:
    """Download a file to dest (atomic via .part rename)."""
    _rate_limit()
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(
        url, headers={"User-Agent": _USER_AGENT}, method="GET"
    )
    with urllib.request.urlopen(req, timeout=60) as resp, open(tmp, "wb") as f:
        shutil.copyfileobj(resp, f)
    if dest.exists():
        dest.unlink()
    tmp.rename(dest)


def _build_search_body(term: str, max_results: int) -> dict:
    """Build RCSB Search API v2 JSON query body using full_text search."""
    return {
        "query": {
            "type": "group",
            "logical_operator": "and",
            "nodes": [
                {
                    "type": "terminal",
                    "service": "full_text",
                    "parameters": {"value": term},
                }
            ],
        },
        "return_type": "entry",
        "request_options": {
            "paginate": {"start": 0, "rows": max_results},
            "results_content_type": ["experimental"],
            "sort": [{"sort_by": "score", "direction": "desc"}],
        },
    }


def _fetch_entry_detail(pdb_id: str) -> dict[str, Any]:
    """Fetch enriched metadata for a single PDB entry from the Data API.

    Returns a dict with ``title``/``organism``/``method``/``resolution``/
    ``deposit_date``. Empty fields stay as empty string / None on failure
    so callers can merge them safely.
    """
    url = f"{_DATA_API}{pdb_id.lower()}"
    try:
        data = _get_json(url)
    except (HTTPError, URLError, TimeoutError, ValueError) as exc:
        logger.warning("PDB describe fetch failed for %s: %s", pdb_id, exc)
        return {}

    struct = data.get("struct", {})
    rcsb = data.get("rcsb_entry_info", {})
    exptl = data.get("exptl", [])
    accession = data.get("rcsb_accession_info", {})

    # organism 字段从 polymer_entities 汇总科学名
    organisms: list[str] = []
    for entity in data.get("polymer_entities", []):
        for src in entity.get("rcsb_entity_source_organism", []):
            name = src.get("scientific_name")
            if name and name not in organisms:
                organisms.append(name)

    return {
        "title": struct.get("title", ""),
        "organism": "; ".join(organisms) if organisms else "",
        "method": exptl[0].get("method", "") if exptl else "",
        "resolution": rcsb.get("resolution_combined", [None])[0],
        "deposit_date": accession.get("deposit_date", ""),
    }


@function_tool
def search_pdb(ctx: RunContextWrapper[Any], term: str, max_results: int = 20) -> str:
    """Search RCSB PDB by keyword (protein name, gene, organism, etc.).

    Uses RCSB Search API v2 with full_text search. Returns PDB IDs with
    titles, organism, and experimental method metadata. The top
    ``min(max_results, 3)`` entries are enriched with full metadata fetched
    from the RCSB Data API (2s rate-limited); the remaining entries carry
    only ``pdb_id`` and the caller can call ``describe_pdb`` for more.
    """
    run_ctx: RunContext = ctx.context
    try:
        body = _build_search_body(term, max_results)
        data = _post_json(_SEARCH_API, body)
    except Exception as exc:
        run_ctx.log_query(term, "pdb", "error", 0)
        return json.dumps({
            "source": "pdb",
            "term": term,
            "pdb_ids": [],
            "records": [],
            "error": str(exc),
        }, ensure_ascii=False)

    result_set = data.get("result_set", [])
    run_ctx.log_query(term, "pdb", "ok", len(result_set))

    records: list[dict[str, Any]] = []
    enrich_limit = min(len(result_set), _DESCRIBE_BATCH_LIMIT)
    for index, entry in enumerate(result_set):
        pdb_id = entry.get("identifier", "")
        record: dict[str, Any] = {
            "pdb_id": pdb_id,
            "title": "",
            "organism": "",
            "method": "",
            "resolution": None,
            "deposit_date": "",
        }
        # 前 N 条调用 Data API 补全字段（RCSB Search API result_set 仅含 identifier）。
        # Rate limiting is handled inside _get_json via _rate_limit().
        if index < enrich_limit and pdb_id:
            record.update(_fetch_entry_detail(pdb_id))
        records.append(record)

    return json.dumps({
        "source": "pdb",
        "term": term,
        "pdb_ids": [r["pdb_id"] for r in records],
        "records": records,
        "enriched_count": enrich_limit,
    }, ensure_ascii=False)


@function_tool
def describe_pdb(ctx: RunContextWrapper[Any], pdb_id: str) -> str:
    """Get detailed metadata about a PDB structure.

    Returns title, deposition date, resolution, experimental method,
    authors, citation info, polymer entities, and ligand/non-polymer info.
    """
    run_ctx: RunContext = ctx.context
    pdb_id = pdb_id.strip().lower()
    url = f"{_DATA_API}{pdb_id}"

    try:
        data = _get_json(url)
    except Exception as exc:
        run_ctx.log_query(pdb_id, "pdb", "failed", 0)
        return json.dumps({
            "source": "pdb",
            "pdb_id": pdb_id,
            "error": str(exc),
        }, ensure_ascii=False)

    struct = data.get("struct", {})
    rcsb = data.get("rcsb_entry_info", {})
    exptl = data.get("exptl", [])
    audit = data.get("audit_author", [])
    citation = data.get("citation", [])
    polymers = data.get("polymer_entities", [])
    non_polymers = data.get("nonpolymer_entities", [])

    run_ctx.log_query(pdb_id, "pdb", "succeeded", 1)
    return json.dumps({
        "source": "pdb",
        "pdb_id": pdb_id.upper(),
        "title": struct.get("title", ""),
        "deposit_date": data.get("rcsb_accession_info", {}).get("deposit_date", ""),
        "resolution": rcsb.get("resolution_combined", [None])[0],
        "method": exptl[0].get("method", "") if exptl else "",
        "molecular_weight": rcsb.get("molecular_weight", None),
        "polymer_count": rcsb.get("polymer_entity_count", 0),
        "authors": [a.get("name", "") for a in audit],
        "citation": citation[0] if citation else None,
        "polymer_entities": polymers,
        "nonpolymer_entities": non_polymers,
        "url": url,
    }, ensure_ascii=False)


@function_tool
def download_pdb(ctx: RunContextWrapper[Any], pdb_id: str, file_type: str = "pdb") -> str:
    """Download a PDB or mmCIF file from RCSB PDB.

    Args:
        pdb_id: PDB identifier (e.g. "1cbs").
        file_type: "pdb" (legacy PDB format) or "cif" (mmCIF format).

    Files are saved to the task raw directory and tracked in provenance.
    Returns a SourceRecord-compatible JSON response.
    """
    run_ctx: RunContext = ctx.context
    pdb_id = pdb_id.strip().lower()
    file_type = file_type.lower().strip()

    if file_type == "pdb":
        url = f"{_FILES_BASE}{pdb_id}.pdb"
        filename = f"{pdb_id}.pdb"
        format_hint = "pdb_legacy"
    elif file_type == "cif":
        url = f"{_FILES_BASE}{pdb_id}.cif"
        filename = f"{pdb_id}.cif"
        format_hint = "mmcif"
    else:
        return json.dumps({
            "source": "pdb",
            "pdb_id": pdb_id,
            "error": f"unsupported file_type: {file_type}. Use 'pdb' or 'cif'.",
        })

    dest = run_ctx.work_dir.raw / filename

    try:
        _download(url, dest)
    except Exception as exc:
        return json.dumps({
            "source": "pdb",
            "pdb_id": pdb_id,
            "error": str(exc),
        }, ensure_ascii=False)

    local_files = [str(run_ctx.work_dir.raw_file(filename))]
    run_ctx.add_raw_asset(local_files[0])

    retrieved_at = datetime.now(UTC)
    source_record = SourceRecord(
        source_id=make_source_id(Database.PDB, pdb_id.upper(), url),
        database=Database.PDB,
        accession=pdb_id.upper(),
        url=url,
        title=f"PDB structure {pdb_id.upper()}",
        retrieved_at=retrieved_at,
    )
    run_ctx.add_source(source_record)

    return json.dumps({
        "source": "pdb",
        "pdb_id": pdb_id.upper(),
        "source_url": url,
        "local_files": local_files,
        "format_hint": format_hint,
        "retrieved_at": retrieved_at.isoformat(),
    }, ensure_ascii=False)


pdb_skill = SkillDef(
    name="pdb",
    category=SkillCategory.ACQUISITION,
    description=(
        "Search, describe, and download protein structures from RCSB PDB. "
        "Use when user asks about protein structures, 3D models, PDB IDs, "
        "or needs structural biology data."
    ),
    instructions=(
        "Use the pdb tools to search RCSB PDB by keyword, inspect structure metadata, "
        "and download PDB or mmCIF files. "
        "Prefer search_pdb to find structures, describe_pdb to inspect metadata, "
        "and download_pdb to retrieve files. "
        "All downloads go to the task raw directory and are tracked in provenance."
    ),
    tools=[search_pdb, describe_pdb, download_pdb],
    supported_sources=["pdb", "rcsb_pdb"],
    version="0.1.0",
)

skill_registry.register(pdb_skill)
