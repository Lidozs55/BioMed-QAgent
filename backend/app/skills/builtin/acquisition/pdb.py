"""RCSB PDB acquisition skill — search, describe, and download protein structures."""
from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext
from app.config import settings
from app.domain.contracts import (
    Database,
    DataLevel,
    QueryStatus,
    SourceRecord,
    make_source_id,
)
from app.integrations.acquisition import acquire_source
from app.skills.builtin.acquisition._download_io import fetch_json
from app.skills.registry import SkillCategory, SkillDef, skill_registry
from app.tools.content_cache import ContentCache

logger = logging.getLogger(__name__)

_SEARCH_API = "https://search.rcsb.org/rcsbsearch/v2/query"
_DATA_API = "https://data.rcsb.org/rest/v1/core/entry/"
_FILES_BASE = "https://files.rcsb.org/download/"

#: search_pdb 内部对前 N 条结果补全详情，避免 N+1 查询阻塞 agent loop。
_DESCRIBE_BATCH_LIMIT = 3


@dataclass(frozen=True)
class PdbServices:
    """Injectable services shared by thin RCSB-facing skill adapters."""

    http: httpx.AsyncClient
    cache: ContentCache


@asynccontextmanager
async def open_pdb_services(
    *,
    http: httpx.AsyncClient | None = None,
    cache_root: Path | None = None,
) -> AsyncIterator[PdbServices]:
    """Open production services, while allowing fixture-owned dependencies."""
    owned_http = http is None
    session = http or httpx.AsyncClient(
        timeout=httpx.Timeout(connect=10.0, read=60.0, write=30.0, pool=10.0)
    )
    try:
        yield PdbServices(
            http=session,
            cache=ContentCache(
                cache_root or Path(settings.output_dir) / "cache" / "pdb"
            ),
        )
    finally:
        if owned_http:
            await session.aclose()


def _post_json(url: str, body: dict) -> dict:
    """POST JSON body and return parsed response (delegates to shared helper)."""
    return fetch_json(url, method="POST", json_body=body)


def _get_json(url: str) -> dict:
    """GET JSON from a URL (delegates to shared helper)."""
    return fetch_json(url)


async def _fetch_json_for_run(
    run_ctx: RunContext,
    url: str,
    *,
    method: str = "GET",
    json_body: dict | None = None,
) -> dict[str, Any]:
    """Use the Run-bound crawler, with urllib retained for isolated tests."""

    facade = run_ctx.crawler_facade_or_none
    if facade is None:
        if run_ctx.subagent_id is not None:
            raise RuntimeError("crawler facade is not bound to the child Run")
        legacy = _post_json if method == "POST" else _get_json
        if method == "POST":
            return await asyncio.to_thread(legacy, url, json_body or {})
        return await asyncio.to_thread(legacy, url)
    if method == "POST":
        result = await facade.api_request(
            url,
            method="POST",
            json_body=json_body or {},
        )
    else:
        result = await facade.api(url)
    if not result.ok:
        raise RuntimeError(result.error or f"HTTP {result.status_code}")
    return json.loads(result.content)


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


async def _fetch_entry_detail(
    run_ctx: RunContext,
    pdb_id: str,
) -> dict[str, Any]:
    """Fetch enriched metadata for a single PDB entry from the Data API.

    Returns a dict with ``title``/``organism``/``method``/``resolution``/
    ``deposit_date``. Empty fields stay as empty string / None on failure
    so callers can merge them safely.
    """
    url = f"{_DATA_API}{pdb_id.lower()}"
    try:
        data = await _fetch_json_for_run(run_ctx, url)
    except Exception as exc:
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


@function_tool(
    description_override=(
        "Search RCSB PDB by keyword (protein name, gene, organism, etc.). "
        "Parameters: ``term`` (required, search keyword like 'TP53' or "
        "'hemoglobin'), ``max_results`` (optional, default 20). "
        "Returns JSON with PDB IDs, titles, organism, and method metadata. "
        "Use ``describe_pdb`` to get full metadata for a specific PDB ID."
    ),
)
async def search_pdb(
    ctx: RunContextWrapper[Any],
    term: str,
    max_results: int = 20,
) -> str:
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
        data = await _fetch_json_for_run(
            run_ctx,
            _SEARCH_API,
            method="POST",
            json_body=body,
        )
    except Exception as exc:
        run_ctx.log_query(term, "pdb", QueryStatus.FAILED, 0)
        return json.dumps({
            "source": "pdb",
            "term": term,
            "pdb_ids": [],
            "records": [],
            "error": str(exc),
        }, ensure_ascii=False)

    result_set = data.get("result_set", [])
    run_ctx.log_query(term, "pdb", QueryStatus.SUCCESS, len(result_set))

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
            record.update(await _fetch_entry_detail(run_ctx, pdb_id))
        records.append(record)

    return json.dumps({
        "source": "pdb",
        "term": term,
        "pdb_ids": [r["pdb_id"] for r in records],
        "records": records,
        "enriched_count": enrich_limit,
    }, ensure_ascii=False)


@function_tool
async def describe_pdb(ctx: RunContextWrapper[Any], pdb_id: str) -> str:
    """Get detailed metadata about a PDB structure.

    Returns title, deposition date, resolution, experimental method,
    authors, citation info, polymer entities, and ligand/non-polymer info.
    """
    run_ctx: RunContext = ctx.context
    pdb_id = pdb_id.strip().lower()
    url = f"{_DATA_API}{pdb_id}"

    try:
        data = await _fetch_json_for_run(run_ctx, url)
    except Exception as exc:
        run_ctx.log_query(pdb_id, "pdb", QueryStatus.FAILED, 0)
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

    run_ctx.log_query(pdb_id, "pdb", QueryStatus.SUCCESS, 1)
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


async def download_pdb_adapter(
    run_ctx: RunContext,
    pdb_id: str,
    file_type: str,
    *,
    services: PdbServices,
    max_size_mb: int = 4096,
) -> str:
    """Download one PDB/mmCIF file through ``acquire_source``.

    Routes the download through the verified acquisition channel (HTTPS
    allowlist, content-addressed cache, checksum, DownloadAttempt), so the
    PDB asset enters ``source_assets.csv`` / ``download_log.csv`` with the
    same contract as GEO/GDC/PubMed supplementary files (TODO Phase 2.5 P1).
    """
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

    try:
        source = SourceRecord(
            source_id=make_source_id(Database.PDB, pdb_id.upper(), url),
            database=Database.PDB,
            accession=pdb_id.upper(),
            url=url,
            title=f"PDB structure {pdb_id.upper()}",
            retrieved_at=datetime.now(UTC),
        )
        result = await acquire_source(
            source=source,
            filename=filename,
            workdir=run_ctx.work_dir,
            cache=services.cache,
            http=services.http,
            data_level=DataLevel.REPOSITORY_PROCESSED,
            max_bytes=max_size_mb * 1024 * 1024,
            accept="application/octet-stream,*/*;q=0.9",
        )
        payload: dict[str, Any] = {
            "source": "pdb",
            "pdb_id": pdb_id.upper(),
            "source_url": source.url,
            "attempt": result.attempt.model_dump(mode="json"),
            "asset": (result.asset.model_dump(mode="json") if result.asset else None),
        }
        if result.asset:
            asset = result.asset
            if run_ctx.subagent_id is not None:
                asset = await asyncio.to_thread(
                    run_ctx.commit_staged_source_asset,
                    asset,
                )
                path = run_ctx.source_asset_path(asset)
            else:
                path = run_ctx.work_dir.root / asset.relative_path
            run_ctx.record_source_asset_id(asset.asset_id)
            run_ctx.add_source(source)
            run_ctx.add_raw_asset(str(path))
            run_ctx.log_query(filename, "pdb", QueryStatus.SUCCESS, 1)
            payload["local_files"] = [str(path)]
            payload["format_hint"] = format_hint
            payload["retrieved_at"] = source.retrieved_at.isoformat()
        else:
            run_ctx.log_query(filename, "pdb", QueryStatus.FAILED, 0)
            payload["error"] = result.attempt.error_message
        return json.dumps(payload, ensure_ascii=False)
    except Exception as exc:
        logger.exception("PDB download failed for pdb_id=%r", pdb_id)
        return json.dumps({
            "source": "pdb",
            "pdb_id": pdb_id,
            "error": str(exc),
        }, ensure_ascii=False)


@function_tool(
    name_override="download_pdb",
    description_override=(
        "Download a PDB or mmCIF file from RCSB PDB as an immutable "
        "repository-processed SourceAsset (verified HTTPS channel with "
        "checksum + content cache). Returns local_files, source_asset, and "
        "the download attempt record."
    ),
)
async def download_pdb(
    ctx: RunContextWrapper[Any],
    pdb_id: str,
    file_type: str = "pdb",
) -> str:
    """Download a PDB or mmCIF file from RCSB PDB via ``acquire_source``."""
    async with open_pdb_services() as services:
        return await download_pdb_adapter(
            ctx.context,
            pdb_id,
            file_type,
            services=services,
        )


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
