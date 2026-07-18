"""Thin Agent Tool adapters for typed GEO discovery and acquisition."""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import urlparse

import httpx
from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext
from app.domain.contracts import Database, DataLevel, QueryStatus, SourceRecord, StageName
from app.integrations.acquisition import acquire_source
from app.integrations.ncbi.discovery import (
    describe_geo_series,
    search_geo_series,
)
from app.integrations.ncbi.factory import NcbiServices, open_ncbi_services
from app.integrations.ncbi.parsers import resolve_geo_supplementary_assets
from app.skills.registry import SkillCategory, SkillDef, skill_registry

logger = logging.getLogger(__name__)


def _retry_delay(response: httpx.Response | None, attempt: int) -> float:
    fallback = 0.25 * (2 ** (attempt - 1))
    if response is None:
        return fallback
    value = response.headers.get("Retry-After")
    if not value:
        return fallback
    try:
        return max(0.0, float(value))
    except ValueError:
        try:
            retry_at = parsedate_to_datetime(value)
            now = datetime.now(retry_at.tzinfo or UTC)
            return max(0.0, (retry_at - now).total_seconds())
        except (TypeError, ValueError, OverflowError):
            return fallback


async def _get_geo_listing(
    http: httpx.AsyncClient,
    url: str,
    *,
    attempts: int = 3,
) -> httpx.Response:
    """Fetch small GEO directory metadata with bounded transient retries."""

    for attempt in range(1, attempts + 1):
        response: httpx.Response | None = None
        try:
            response = await http.get(url, follow_redirects=False)
            if response.status_code == 429 or response.status_code >= 500:
                response.raise_for_status()
            return response
        except (httpx.TimeoutException, httpx.TransportError, httpx.HTTPStatusError):
            if attempt == attempts:
                raise
            await asyncio.sleep(_retry_delay(response, attempt))
    raise RuntimeError("unreachable")


def _geo_record_json(record: Any) -> dict[str, Any]:
    payload = record.model_dump(mode="json")
    payload.update(
        {
            "platform_count": len(record.platform_ids),
            "pubmed_id": "; ".join(record.pubmed_ids),
        }
    )
    return payload


def _https_ftp_root(value: str, accession: str) -> str:
    root = value.strip()
    if root.startswith("ftp://ftp.ncbi.nlm.nih.gov/"):
        root = "https://" + root.removeprefix("ftp://")
    if not root:
        prefix = accession[:-3] + "nnn"
        root = f"https://ftp.ncbi.nlm.nih.gov/geo/series/{prefix}/{accession}/"
    return root.rstrip("/") + "/"


async def search_geo_adapter(
    run_ctx: RunContext,
    term: str,
    max_results: int,
    *,
    services: NcbiServices,
) -> str:
    """Adapt typed GEO series results without treating numeric UIDs as accessions."""

    try:
        result = await search_geo_series(services.eutils, term, max_results)
        records = [_geo_record_json(record) for record in result.records]
        run_ctx.log_query(term, "geo", QueryStatus.SUCCESS, len(records))
        # Surface mid-stage progress: "GEO: found N datasets (of M total hits)".
        # See docs/REVIEW_2026-07-18.md §4.
        await run_ctx.emit_progress(
            stage=StageName.DISCOVERY,
            kind="discovered_records",
            current=len(records),
            total=result.total_count,
            detail={"source": "geo", "term": term},
        )
        return json.dumps(
            {
                "source": "geo",
                "term": term,
                "query_translation": result.query_translation,
                "total_count": result.total_count,
                "accessions": [record["accession"] for record in records],
                "records": records,
            },
            ensure_ascii=False,
        )
    except Exception as exc:
        logger.exception("GEO search failed for term=%r", term)
        run_ctx.log_query(term, "geo", QueryStatus.FAILED, 0)
        return json.dumps(
            {
                "source": "geo",
                "term": term,
                "accessions": [],
                "records": [],
                "error": str(exc),
            },
            ensure_ascii=False,
        )


async def describe_geo_adapter(
    run_ctx: RunContext,
    accession: str,
    *,
    services: NcbiServices,
) -> str:
    """Resolve and serialize one GSE record through NCBI E-utilities.

    NCBI E-utilities ``esummary`` against the ``gds`` database exposes only
    series-level metadata (title, summary, organism, experiment_type, samples,
    platform IDs, PubMed IDs, FTP root). It does **not** return per-platform
    title/organism, overall_design, or supplementary file URLs — those require
    fetching the GEO FTP ``suppl/`` listing separately. We surface the listing
    URL rather than fabricating empty placeholders so callers can decide
    whether to enumerate supplementary files via ``download_geo(file_type="suppl")``.
    """

    try:
        record = await describe_geo_series(services.eutils, accession)
        payload = _geo_record_json(record)
        suppl_listing_url = ""
        if record.ftp_root:
            suppl_listing_url = _https_ftp_root(
                record.ftp_root, record.accession
            ) + "suppl/"
        payload.update(
            {
                # Real, derivable URL — caller can fetch this for suppl file list.
                "supplementary_file_listing_url": suppl_listing_url,
                # Honest note: fields not exposed by NCBI esummary. Don't
                # fabricate empty placeholders that imply the data is there.
                "note": (
                    "NCBI E-utilities esummary does not expose overall_design, "
                    "per-platform title/organism, or supplementary file URLs. "
                    "Use platform_ids for GPL lookups and "
                    "supplementary_file_listing_url (or download_geo with "
                    "file_type='suppl') to enumerate supplementary files."
                ),
            }
        )
        return json.dumps(
            {"source": "geo", **payload},
            ensure_ascii=False,
        )
    except Exception as exc:
        logger.exception("GEO description failed for accession=%r", accession)
        return json.dumps(
            {"source": "geo", "accession": accession, "error": str(exc)},
            ensure_ascii=False,
        )


async def _resolve_download(
    accession: str,
    file_type: str,
    filename: str | None,
    services: NcbiServices,
) -> tuple[SourceRecord, str, DataLevel]:
    record = await describe_geo_series(services.eutils, accession)
    root = _https_ftp_root(record.ftp_root, record.accession)
    normalized_type = file_type.lower().strip()

    if normalized_type == "matrix":
        selected_filename = filename or f"{record.accession}_series_matrix.txt.gz"
        url = f"{root}matrix/{selected_filename}"
    elif normalized_type == "soft":
        selected_filename = filename or f"{record.accession}_family.soft.gz"
        url = f"{root}soft/{selected_filename}"
    elif normalized_type == "suppl":
        listing_url = f"{root}suppl/"
        response = await _get_geo_listing(services.http, listing_url)
        response.raise_for_status()
        candidates = resolve_geo_supplementary_assets(response.content, listing_url)
        if filename:
            candidates = [item for item in candidates if item.filename == filename]
        if not candidates:
            raise LookupError("no matching GEO supplementary file found")
        if len(candidates) > 1 and filename is None:
            raise ValueError("multiple supplementary files found; specify filename")
        selected_filename = candidates[0].filename
        url = candidates[0].url
    else:
        raise ValueError(f"unsupported file_type: {file_type}")

    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != "ftp.ncbi.nlm.nih.gov":
        raise ValueError("GEO download must resolve to official NCBI HTTPS")
    source = SourceRecord(
        source_id=f"src_geo_{record.accession.lower()}_{normalized_type}",
        database=Database.GEO,
        accession=record.accession,
        url=url,
        title=record.title,
        retrieved_at=datetime.now(UTC),
    )
    return source, selected_filename, DataLevel.REPOSITORY_PROCESSED


async def download_geo_adapter(
    run_ctx: RunContext,
    accession: str,
    file_type: str,
    *,
    services: NcbiServices,
    filename: str | None = None,
    max_size_mb: int = 100,
    expected_size: int | None = None,
    expected_sha256: str | None = None,
) -> str:
    """Download one official GEO file and return its immutable SourceAsset JSON."""

    try:
        source, selected_filename, data_level = await _resolve_download(
            accession, file_type, filename, services
        )
        result = await acquire_source(
            source=source,
            filename=selected_filename,
            workdir=run_ctx.work_dir,
            cache=services.cache,
            http=services.http,
            data_level=data_level,
            max_bytes=max_size_mb * 1024 * 1024,
            expected_size=expected_size,
            expected_sha256=expected_sha256,
        )
        payload: dict[str, Any] = {
            "source": "geo",
            "accession": source.accession,
            "source_url": source.url,
            "attempt": result.attempt.model_dump(mode="json"),
            "asset": (result.asset.model_dump(mode="json") if result.asset else None),
        }
        if result.asset:
            path = run_ctx.work_dir.root / result.asset.relative_path
            run_ctx.add_source(source)
            run_ctx.add_raw_asset(str(path))
            payload["local_files"] = [str(path)]
            payload["format_hint"] = file_type.lower().strip()
            # Surface download progress: "GEO: downloaded N bytes (1 asset)".
            # See docs/REVIEW_2026-07-18.md §4.
            await run_ctx.emit_progress(
                stage=StageName.ACQUISITION,
                kind="downloaded_bytes",
                current=result.asset.size_bytes,
                total=None,
                detail={
                    "source": "geo",
                    "accession": source.accession,
                    "filename": selected_filename,
                    "records": 1,
                },
            )
        else:
            payload["error"] = result.attempt.error_message
        return json.dumps(payload, ensure_ascii=False)
    except Exception as exc:
        logger.exception("GEO download failed for accession=%r", accession)
        return json.dumps(
            {"source": "geo", "accession": accession, "error": str(exc)},
            ensure_ascii=False,
        )


@function_tool(
    name_override="search_geo",
    description_override="Search NCBI GEO and return typed GSE series records.",
)
async def search_geo(
    ctx: RunContextWrapper[Any], term: str, max_results: int = 20
) -> str:
    async with open_ncbi_services() as services:
        return await search_geo_adapter(
            ctx.context, term, max_results, services=services
        )


@function_tool(
    name_override="describe_geo",
    description_override="Describe one GEO series accession using NCBI metadata.",
)
async def describe_geo(ctx: RunContextWrapper[Any], accession: str) -> str:
    async with open_ncbi_services() as services:
        return await describe_geo_adapter(ctx.context, accession, services=services)


@function_tool(
    name_override="download_geo",
    description_override=(
        "Download a GEO matrix, SOFT, or supplementary file as an immutable "
        "repository-processed SourceAsset. Compressed files remain compressed."
    ),
)
async def download_geo(
    ctx: RunContextWrapper[Any],
    accession: str,
    file_type: str = "matrix",
    filename: str | None = None,
    max_size_mb: int = 100,
) -> str:
    async with open_ncbi_services() as services:
        return await download_geo_adapter(
            ctx.context,
            accession,
            file_type,
            services=services,
            filename=filename,
            max_size_mb=max_size_mb,
        )


geo_skill = SkillDef(
    name="geo",
    category=SkillCategory.ACQUISITION,
    description=(
        "Search, describe, and download GEO (NCBI Gene Expression Omnibus) "
        "datasets. Use when user asks about GEO series or gene expression data."
    ),
    instructions=(
        "Use search_geo to find GSE accessions, describe_geo to inspect typed "
        "metadata, and download_geo to retrieve verified compressed source assets. "
        "For supplementary listings containing several files, specify filename."
    ),
    tools=[search_geo, describe_geo, download_geo],
    supported_sources=["geo", "ncbi_geo"],
    version="0.2.0",
)

skill_registry.register(geo_skill)
