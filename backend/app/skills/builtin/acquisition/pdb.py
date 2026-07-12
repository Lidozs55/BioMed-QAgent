"""RCSB PDB acquisition skill — search, describe, and download protein structures."""
from __future__ import annotations

import json
import logging
import urllib.request
from pathlib import Path
from typing import Any

from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext
from app.domain.output import SourceRecord
from app.skills.registry import SkillCategory, SkillDef, skill_registry

logger = logging.getLogger(__name__)

_SEARCH_API = "https://search.rcsb.org/rcsbsearch/v2/query"
_DATA_API = "https://data.rcsb.org/rest/v1/core/entry/"
_FILES_BASE = "https://files.rcsb.org/download/"


def _post_json(url: str, body: dict) -> dict:
    """POST JSON body and return parsed response."""
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def _get_json(url: str) -> dict:
    """GET JSON from a URL."""
    with urllib.request.urlopen(url, timeout=30) as resp:
        return json.loads(resp.read().decode())


def _download(url: str, dest: Path) -> None:
    """Download a file to dest (atomic via .part rename)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    urllib.request.urlretrieve(url, tmp)
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


@function_tool
def search_pdb(ctx: RunContextWrapper[Any], term: str, max_results: int = 20) -> str:
    """Search RCSB PDB by keyword (protein name, gene, organism, etc.).

    Uses RCSB Search API v2 with full_text search. Returns PDB IDs with
    titles, organism, and experimental method metadata.
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
        })

    result_set = data.get("result_set", [])
    run_ctx.log_query(term, "pdb", "ok", len(result_set))

    records: list[dict[str, Any]] = []
    for entry in result_set:
        records.append({
            "pdb_id": entry.get("identifier", ""),
            "title": entry.get("title", ""),
            "organism": entry.get("entity_poly", {}).get("rcsb_entity_polymer_type", ""),
            "method": entry.get("exptl", [{}])[0].get("method", "") if entry.get("exptl") else "",
            "resolution": entry.get("rcsb_entry_info", {}).get("resolution_combined", [None])[0]
            if entry.get("rcsb_entry_info") else None,
            "deposit_date": entry.get("rcsb_accession_info", {}).get("deposit_date", ""),
        })

    return json.dumps({
        "source": "pdb",
        "term": term,
        "pdb_ids": [r["pdb_id"] for r in records],
        "records": records,
    })


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
        return json.dumps({
            "source": "pdb",
            "pdb_id": pdb_id,
            "error": str(exc),
        })

    struct = data.get("struct", {})
    rcsb = data.get("rcsb_entry_info", {})
    exptl = data.get("exptl", [])
    audit = data.get("audit_author", [])
    citation = data.get("citation", [])
    polymers = data.get("polymer_entities", [])
    non_polymers = data.get("nonpolymer_entities", [])

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
    })


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
        })

    local_files = [str(run_ctx.work_dir.raw_file(filename))]
    run_ctx.add_raw_asset(local_files[0])

    source_record = SourceRecord(
        source="pdb",
        accession=pdb_id.upper(),
        source_url=url,
        local_files=local_files,
        format_hint=format_hint,
    )
    run_ctx.add_source(source_record)

    return json.dumps({
        "source": "pdb",
        "pdb_id": pdb_id.upper(),
        "source_url": url,
        "local_files": local_files,
        "format_hint": format_hint,
        "retrieved_at": source_record.retrieved_at.isoformat(),
    })


pdb_skill = SkillDef(
    name="pdb",
    category=SkillCategory.ACQUISITION,
    description="Search, describe, and download protein structures from RCSB PDB. Use when user asks about protein structures, 3D models, PDB IDs, or needs structural biology data.",
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
