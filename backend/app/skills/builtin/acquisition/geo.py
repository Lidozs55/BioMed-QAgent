"""Thin Agent Tool adapters for typed GEO discovery and acquisition."""

from __future__ import annotations

import asyncio
import gzip
import json
import logging
import re
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlparse

import httpx
from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext
from app.domain.contracts import (
    Database,
    DataLevel,
    GeoSeriesRecord,
    QueryStatus,
    SourceRecord,
    StageName,
)
from app.integrations.acquisition import acquire_source
from app.integrations.ncbi.client import parse_retry_after
from app.integrations.ncbi.discovery import (
    describe_geo_series,
    search_geo_series,
)
from app.integrations.ncbi.factory import NcbiServices, open_ncbi_services
from app.integrations.ncbi.parsers import resolve_geo_supplementary_assets
from app.pipeline.processing.geo_annotation import (
    discover_annotation_file,
    geo_platform_dir,
)
from app.skills.categories import SkillCategory

logger = logging.getLogger(__name__)


def _retry_delay(response: httpx.Response | None, attempt: int) -> float:
    fallback = 0.25 * (2 ** (attempt - 1))
    if response is None:
        return fallback
    value = response.headers.get("Retry-After")
    if not value:
        return fallback
    delay = parse_retry_after(value, now=datetime.now(UTC))
    return delay if delay > 0 else fallback


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
        # REVIEW 2026-08-05 P3-2: 与 pipeline 层 _geo_series_dir 对齐，强制大写
        # （NCBI FTP 路径大小写敏感，小写 accession 会构造出 404 目录）。
        prefix = accession[:-3].upper() + "nnn"
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
        run_ctx.add_geo_series_record(record)
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


_GEO_FILE_TYPES = ("matrix", "soft", "suppl")


def _matrix_has_data_table(path: Any) -> bool:
    """Return True if a GEO series-matrix gzip contains an expression table.

    NCBI serves metadata-only series matrices for RNA-seq series (and some
    array series): the gzip decompresses to ``!Series_*`` header lines but has
    no ``!series_matrix_table_begin`` block, so the expression adapter would
    later fail with ``no_primary_data``.  Detecting this at download time lets
    the tool fail fast and steer the agent to ``soft/`` or ``suppl/`` instead
    of burning a build attempt.  (See docs/REVIEW_2026-08-10-task-9ce0124f.md
    §5.1 T2.)
    """
    try:
        with gzip.open(path, "rt", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                if line.startswith("!series_matrix_table_begin"):
                    return True
    except (OSError, EOFError, UnicodeDecodeError):
        return False
    return False


async def _resolve_download(
    accession: str,
    file_type: str,
    filename: str | None,
    services: NcbiServices,
) -> tuple[SourceRecord, str, DataLevel, GeoSeriesRecord]:
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
            filtered = [item for item in candidates if item.filename == filename]
            if not filtered:
                # Surface the actual available filenames so the agent can
                # self-correct instead of guessing again. (See docs/ISSUES.md
                # #260803-6.)
                available = [item.filename for item in candidates]
                raise LookupError(
                    f"no matching GEO supplementary file found for "
                    f"filename={filename!r}; available files: {available}"
                )
            candidates = filtered
        if not candidates:
            raise LookupError("no matching GEO supplementary file found")
        if len(candidates) > 1 and filename is None:
            # Surface the candidate filenames so the caller can pick one
            # without re-fetching the listing.
            available = [item.filename for item in candidates]
            raise ValueError(
                f"multiple supplementary files found; specify filename. "
                f"available files: {available}"
            )
        selected_filename = candidates[0].filename
        url = candidates[0].url
    else:
        raise ValueError(
            f"unsupported file_type: {file_type!r}; "
            f"expected one of {', '.join(_GEO_FILE_TYPES)}"
        )

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
    return source, selected_filename, DataLevel.REPOSITORY_PROCESSED, record


async def list_geo_supplementary_files_adapter(
    run_ctx: RunContext,
    accession: str,
    *,
    services: NcbiServices,
) -> str:
    """List downloadable supplementary files for a GEO series.

    NCBI E-utilities ``esummary`` does not expose supplementary file URLs, so
    the agent previously had to guess filenames when calling ``download_geo``.
    This adapter fetches the GEO FTP ``suppl/`` directory listing and returns
    the parsed candidate list, letting the agent pick an explicit filename
    before downloading. (See docs/ISSUES.md #260803-5.)
    """

    try:
        record = await describe_geo_series(services.eutils, accession)
        root = _https_ftp_root(record.ftp_root, record.accession)
        listing_url = f"{root}suppl/"
        response = await _get_geo_listing(services.http, listing_url)
        response.raise_for_status()
        candidates = resolve_geo_supplementary_assets(response.content, listing_url)
        files = [
            {
                "filename": item.filename,
                "url": item.url,
                "media_type": item.media_type,
                "data_level": item.data_level.value,
            }
            for item in candidates
        ]
        return json.dumps(
            {
                "source": "geo",
                "accession": record.accession,
                "supplementary_file_count": len(files),
                "supplementary_files": files,
                "listing_url": listing_url,
            },
            ensure_ascii=False,
        )
    except Exception as exc:
        logger.exception(
            "GEO supplementary listing failed for accession=%r", accession
        )
        return json.dumps(
            {"source": "geo", "accession": accession, "error": str(exc)},
            ensure_ascii=False,
        )


async def download_geo_adapter(
    run_ctx: RunContext,
    accession: str,
    file_type: str,
    *,
    services: NcbiServices,
    filename: str | None = None,
    max_size_mb: int = 4096,
    expected_size: int | None = None,
    expected_sha256: str | None = None,
) -> str:
    """Download one official GEO file and return its immutable SourceAsset JSON."""

    try:
        source, selected_filename, data_level, geo_record = await _resolve_download(
            accession, file_type, filename, services
        )
        run_ctx.add_geo_series_record(geo_record)
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
            asset = result.asset
            if run_ctx.subagent_id is not None:
                asset = await asyncio.to_thread(
                    run_ctx.commit_staged_source_asset,
                    asset,
                )
                path = run_ctx.source_asset_path(asset)
            else:
                path = run_ctx.work_dir.root / asset.relative_path
            # Fail fast on metadata-only series matrices: NCBI serves these
            # for RNA-seq (and some array) series, and the expression adapter
            # would otherwise fail later with no_primary_data.  Surface the
            # real data locations so the agent can self-correct instead of
            # burning a build attempt.  (See docs/REVIEW_2026-08-10-task-9ce0124f.md
            # §5.1 T2.)
            if (
                file_type.lower().strip() == "matrix"
                and not _matrix_has_data_table(path)
            ):
                return json.dumps(
                    {
                        "source": "geo",
                        "accession": source.accession,
                        "source_url": source.url,
                        "error": (
                            "series matrix contains no expression table "
                            "(metadata-only). The expression data for this "
                            "series lives in soft/ or suppl/ — try "
                            "download_geo(file_type='soft') or "
                            "download_geo(file_type='suppl') after "
                            "list_geo_supplementary_files."
                        ),
                        "reason_code": "empty_series_matrix",
                    },
                    ensure_ascii=False,
                )
            run_ctx.record_source_asset_id(asset.asset_id)
            run_ctx.add_source(source)
            run_ctx.add_raw_asset(str(path))
            payload["local_files"] = [str(path)]
            payload["asset"] = asset.model_dump(mode="json")
            payload["format_hint"] = file_type.lower().strip()
            # Surface download progress: "GEO: downloaded N bytes (1 asset)".
            # See docs/REVIEW_2026-07-18.md §4.
            await run_ctx.emit_progress(
                stage=StageName.ACQUISITION,
                kind="downloaded_bytes",
                current=asset.size_bytes,
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
    description_override=(
        "Search NCBI GEO for GSE series records. "
        "Parameters: ``query`` (required, search keyword like 'METTL5' or "
        "'pancreatic cancer') — ``term`` is accepted as a legacy alias; "
        "``max_results`` (optional, default 20). "
        "Returns JSON with source, count, and structured GSE records "
        "(accession, title, summary, sample_count, platform, etc.)."
    ),
)
async def search_geo(
    ctx: RunContextWrapper[Any],
    query: str = "",
    max_results: int = 20,
    term: str = "",
) -> str:
    # Accept both ``query`` (consistent with search_pubmed) and ``term``
    # (legacy parameter name) so the agent doesn't waste a round on a schema
    # rejection. ``query`` takes precedence. (See docs/ISSUES.md #260803-7.)
    effective_term = query or term
    if not effective_term:
        return json.dumps(
            {
                "source": "geo",
                "error": "either 'query' or 'term' must be provided",
            },
            ensure_ascii=False,
        )
    async with open_ncbi_services() as services:
        return await search_geo_adapter(
            ctx.context, effective_term, max_results, services=services
        )


@function_tool(
    name_override="describe_geo",
    description_override="Describe one GEO series accession using NCBI metadata.",
)
async def describe_geo(ctx: RunContextWrapper[Any], accession: str) -> str:
    async with open_ncbi_services() as services:
        return await describe_geo_adapter(ctx.context, accession, services=services)


@function_tool(
    name_override="list_geo_supplementary_files",
    description_override=(
        "List downloadable supplementary files for a GEO series accession. "
        "Use this BEFORE download_geo(file_type='suppl') so you can pass an "
        "explicit filename instead of guessing. Returns JSON with "
        "supplementary_files (filename, url, media_type, data_level)."
    ),
)
async def list_geo_supplementary_files(
    ctx: RunContextWrapper[Any], accession: str
) -> str:
    async with open_ncbi_services() as services:
        return await list_geo_supplementary_files_adapter(
            ctx.context, accession, services=services
        )


@function_tool(
    name_override="download_geo",
    description_override=(
        "Download a GEO matrix, SOFT, or supplementary file as an immutable "
        "repository-processed SourceAsset. Compressed files remain compressed. "
        "max_size_mb caps the download size (default 4096 MiB — large enough "
        "for real series matrices like GSE33000's 107 MiB file); raise it "
        "explicitly for very large supplementary files. "
        "For file_type='suppl', call list_geo_supplementary_files first to get "
        "the exact filename."
    ),
)
async def download_geo(
    ctx: RunContextWrapper[Any],
    accession: str,
    file_type: str = "matrix",
    filename: str | None = None,
    max_size_mb: int = 4096,
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


_ANNOTATION_FTP_ROOT = "https://ftp.ncbi.nlm.nih.gov/geo/platforms"
_GPL_RE = re.compile(r"^GPL\d+$")


async def download_geo_platform_annotation_adapter(
    run_ctx: RunContext,
    gpl: str,
    *,
    services: NcbiServices,
    max_size_mb: int = 4096,
) -> str:
    """Download the GEO SOFT platform annotation table for *gpl*.

    Locates the annotation file (``suppl/{gpl}_*.txt.gz`` Agilent-style or
    ``annot/{gpl}.annot.gz`` Affymetrix-style), acquires it through the
    content-addressed ``acquire_source`` path (so the file lands in the task
    workdir as a provenance-tracked SourceAsset) and returns the agent-facing
    JSON envelope.  The returned file is what ``execute_dataset_build``
    expects under ``mapping_files`` for a probe-platform binding.
    """

    if not _GPL_RE.fullmatch(gpl or ""):
        return json.dumps(
            {
                "source": "geo",
                "platform": gpl,
                "error": "gpl must match ^GPL\\d+$ (e.g. 'GPL570')",
            },
            ensure_ascii=False,
        )
    try:
        # Platform annotation discovery is a tiny FTP HTML listing; reuse the
        # shared V1/V2 discovery helper (single implementation of the
        # GPL-prefix + file-layout rules, review-loop R2b-02).
        with httpx.Client(
            follow_redirects=True,
            timeout=httpx.Timeout(connect=10.0, read=60.0, write=30.0, pool=10.0),
            headers={"User-Agent": "Mozilla/5.0 (BioMedQAgent pipeline)"},
        ) as client:
            located = discover_annotation_file(client, gpl)
        if located is None:
            return json.dumps(
                {
                    "source": "geo",
                    "platform": gpl,
                    "error": (
                        f"no downloadable annotation table for {gpl}; the "
                        "platform ships no SOFT annotation (some custom/Agilent "
                        "platforms ship only sequence columns)"
                    ),
                },
                ensure_ascii=False,
            )
        subdir, filename = located
        url = (
            f"{_ANNOTATION_FTP_ROOT}/{geo_platform_dir(gpl)}"
            f"/{gpl}/{subdir}/{filename}"
        )
        source = SourceRecord(
            source_id=f"src_geo_{gpl.lower()}_annotation",
            database=Database.GEO,
            accession=gpl,
            url=url,
            title=f"GEO platform annotation {gpl}",
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
            accept="application/gzip, text/plain",
        )
        payload: dict[str, Any] = {
            "source": "geo",
            "platform": gpl,
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
            payload["local_files"] = [str(path)]
            payload["asset"] = asset.model_dump(mode="json")
            payload["format_hint"] = "platform_annotation"
            await run_ctx.emit_progress(
                stage=StageName.ACQUISITION,
                kind="downloaded_bytes",
                current=asset.size_bytes,
                total=None,
                detail={
                    "source": "geo",
                    "platform": gpl,
                    "filename": filename,
                    "records": 1,
                },
            )
        else:
            payload["error"] = result.attempt.error_message
        return json.dumps(payload, ensure_ascii=False)
    except Exception as exc:
        logger.exception(
            "GEO platform annotation download failed for gpl=%r", gpl
        )
        return json.dumps(
            {"source": "geo", "platform": gpl, "error": str(exc)},
            ensure_ascii=False,
        )


@function_tool(
    name_override="download_geo_platform_annotation",
    description_override=(
        "Download the NCBI GEO platform annotation table (SOFT) for a GPL "
        "platform as an immutable SourceAsset. The annotation maps probe IDs "
        "to gene identifiers and is required for a probe-platform (microarray) "
        "GEO build to produce gene-level rows — pass the returned file via "
        "the ``mapping_files`` parameter of execute_dataset_build "
        "(binding_id -> annotation path). Parameters: ``gpl`` (required, "
        "e.g. 'GPL570'), ``max_size_mb`` (optional, default 4096). Returns JSON "
        "with platform, asset and local_files. Fails cleanly when the "
        "platform ships no downloadable annotation table."
    ),
)
async def download_geo_platform_annotation(
    ctx: RunContextWrapper[Any],
    gpl: str,
    max_size_mb: int = 4096,
) -> str:
    async with open_ncbi_services() as services:
        return await download_geo_platform_annotation_adapter(
            ctx.context,
            gpl,
            services=services,
            max_size_mb=max_size_mb,
        )


SKILL_NAME = 'geo'
SKILL_CATEGORY = SkillCategory.ACQUISITION
SKILL_DESCRIPTION = (
    'Search, describe, and download GEO (NCBI Gene Expression Omnibus) datasets. Use when user'
    'asks about GEO series or gene expression data.'
)
SKILL_VERSION = '0.5.0'
SUPPORTED_SOURCES = ['geo', 'ncbi_geo']
SKILL_TOOLS = [
    search_geo,
    describe_geo,
    list_geo_supplementary_files,
    download_geo,
    download_geo_platform_annotation,
]
