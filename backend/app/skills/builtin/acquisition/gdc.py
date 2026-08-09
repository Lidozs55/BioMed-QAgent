"""GDC acquisition skill — search, describe, and download from NCI Genomic Data Commons."""
from __future__ import annotations

import asyncio
import json
import logging
import urllib.parse
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError

from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext
from app.domain.contracts import (
    Database,
    DataLevel,
    QueryStatus,
    SourceRecord,
    generate_prefixed_uuid,
    make_source_id,
)
from app.skills.builtin.acquisition._download_io import (
    _write_download,
    download_file,
    fetch_json,
)
from app.skills.registry import SkillCategory, SkillDef, skill_registry

logger = logging.getLogger(__name__)

_GDC_API_BASE = "https://api.gdc.cancer.gov"

#: Token 短于该字符数时不参与 OR 匹配（避免 "and"/"or" 等噪声词）。
_MIN_TOKEN_LEN = 3


# ---------------------------------------------------------------------------
# Mappings — user-friendly data type names → GDC API data_type values
# ---------------------------------------------------------------------------
_DATA_TYPE_MAP: dict[str, str] = {
    "rna-seq": "Gene Expression Quantification",
    "rna_seq": "Gene Expression Quantification",
    "rnaseq": "Gene Expression Quantification",
    "gene expression": "Gene Expression Quantification",
    "mirna-seq": "miRNA Expression Quantification",
    "mirna": "miRNA Expression Quantification",
    "cna": "Copy Number Segment",
    "cnv": "Copy Number Segment",
    "methylation": "Methylation Beta Value",
    "somatic": "Masked Somatic Mutation",
    "mutation": "Masked Somatic Mutation",
    "clinical": "Clinical Supplement",
    "slide": "Slide Image",
    "biospecimen": "Biospecimen Supplement",
}

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _build_url(path: str, params: dict[str, str] | None = None) -> str:
    """Build a GDC API URL with query parameters."""
    base = f"{_GDC_API_BASE}{path}"
    if not params:
        return base
    return base + "?" + urllib.parse.urlencode(params)


def _fetch_json(url: str) -> dict[str, Any]:
    """Fetch and parse JSON from a GDC REST API endpoint.

    Delegates to the shared ``_download_io.fetch_json`` helper (rate-limited,
    browser UA, 30s timeout).
    """
    return fetch_json(url)


def _download_file(url: str, dest: Path) -> None:
    """Download a file to *dest* (delegates to shared ``_download_io.download_file``)."""
    download_file(url, dest)


async def _fetch_json_for_run(run_ctx: RunContext, url: str) -> dict[str, Any]:
    """Use the Run-bound crawler, with urllib retained for isolated tests."""

    facade = run_ctx.crawler_facade_or_none
    if facade is None:
        if run_ctx.subagent_id is not None:
            raise RuntimeError("crawler facade is not bound to the child Run")
        return await asyncio.to_thread(fetch_json, url)
    result = await facade.api(url)
    if not result.ok:
        raise RuntimeError(result.error or f"HTTP {result.status_code}")
    return json.loads(result.content)


async def _download_file_for_run(
    run_ctx: RunContext,
    url: str,
    dest: Path,
) -> None:
    """Download through the bound crawler or isolated legacy transport."""

    facade = run_ctx.crawler_facade_or_none
    if facade is None:
        if run_ctx.subagent_id is not None:
            raise RuntimeError("crawler facade is not bound to the child Run")
        await asyncio.to_thread(download_file, url, dest)
        return
    result = await facade.download(url)
    if not result.ok:
        raise RuntimeError(result.error or f"HTTP {result.status_code}")
    await asyncio.to_thread(_write_download, result.content, dest)


def _normalize_data_type(data_type: str) -> str:
    """Resolve a shorthand data type to its full GDC API name."""
    return _DATA_TYPE_MAP.get(data_type.strip().lower(), data_type.strip())


def _match_term(term: str, search_text: str) -> bool:
    """Token-OR matching for GDC project search.

    The legacy substring match rejected multi-word queries like
    ``"breast cancer TP53"`` because no project record contains that exact
    phrase. We now split the term into tokens (≥3 chars) and accept the
    record if any token appears in the search text. Single-token queries
    (e.g. ``"TCGA-BRCA"``) preserve the original exact-substring behaviour.
    """
    if not term:
        return False
    term_lower = term.lower()
    text_lower = search_text.lower()
    # 单 token（无空格、无连字符拆分）：保留精确子串匹配
    if " " not in term_lower:
        return term_lower in text_lower
    # 多 token：拆分后任一 token ≥3 字符命中即匹配（OR 语义）
    tokens = [t for t in term_lower.split() if len(t) >= _MIN_TOKEN_LEN]
    if not tokens:
        return term_lower in text_lower
    return any(tok in text_lower for tok in tokens)


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


@function_tool(
    description_override=(
        "Search the NCI Genomic Data Commons for projects matching a keyword. "
        "Parameters: ``query`` (required, search keyword like 'lung cancer' or "
        "'TCGA-BRCA') — ``term`` is accepted as a legacy alias; "
        "``max_results`` (optional, default 20). "
        "Returns JSON with project_id, name, disease_type, and primary_site. "
        "Use ``describe_gdc`` to get detailed metadata for a project."
    ),
)
async def search_gdc(
    ctx: RunContextWrapper[Any],
    query: str = "",
    max_results: int = 20,
    term: str = "",
) -> str:
    """Search the NCI Genomic Data Commons for projects matching a keyword.

    Queries the /projects endpoint with summary expansion and then filters
    locally by matching *term* against project_id, name, disease_type, and
    primary_site. Matching is token-OR for multi-word queries (any token
    ≥3 chars appears in the project metadata → match); single-token
    queries use exact substring match. Use a project_id like ``TCGA-BRCA``
    for precise lookup.

    The /cases endpoint is used indirectly via the project summary
    expansion to obtain case counts without additional round-trips.

    Args:
        ctx: Run context (injected by the OpenAI Agents SDK).
        query: Search keyword or phrase (e.g. "lung", "TCGA-LUAD",
              "breast cancer", "breast cancer TP53"). Recommended parameter
              name, aligned with the other search skills; ``term`` is
              accepted as a legacy alias.
        max_results: Maximum number of project records to return
                     (default 20).
        term: Legacy alias for ``query``. Ignored when ``query`` is non-empty.

    Returns:
        JSON string with keys:
            source       – always "gdc"
            term         – search term used
            project_ids  – list of matching GDC project IDs
            records      – list of dicts with project_id, name,
                           disease_type, primary_site, case_count,
                           file_count, data_categories
            error        – present only on failure
    """
    run_ctx: RunContext = ctx.context
    effective_term = query or term
    try:
        url = _build_url("/projects", {
            "format": "json",
            "size": "200",
            "expand": (
                "summary,summary.case_count,summary.file_count,"
                "summary.data_categories"
            ),
        })
        data = await _fetch_json_for_run(run_ctx, url)
    except (HTTPError, URLError, OSError, TimeoutError, ValueError) as exc:
        run_ctx.log_query(effective_term, "gdc", QueryStatus.FAILED, 0)
        return json.dumps({
            "source": "gdc",
            "term": effective_term,
            "project_ids": [],
            "records": [],
            "error": str(exc),
        }, ensure_ascii=False)

    hits: list[dict[str, Any]] = data.get("data", {}).get("hits", [])
    records: list[dict[str, Any]] = []

    for hit in hits:
        pid: str = hit.get("project_id", "")
        name: str = hit.get("name", "")
        disease: list[str] = hit.get("disease_type") or []
        primary_site: list[str] = hit.get("primary_site") or []
        summary: dict[str, Any] = hit.get("summary", {}) or {}

        # Build searchable text from all human-readable fields
        search_text = " ".join([
            pid,
            name,
            *disease,
            *primary_site,
        ])
        if not _match_term(effective_term, search_text):
            continue

        data_categories = [
            dc.get("data_category", "")
            for dc in (hit.get("summary", {}).get("data_categories", []) or [])
        ]

        records.append({
            "project_id": pid,
            "name": name,
            "disease_type": disease,
            "primary_site": primary_site,
            "case_count": summary.get("case_count", 0),
            "file_count": summary.get("file_count", 0),
            "data_categories": data_categories,
        })

        if len(records) >= max_results:
            break

    run_ctx.log_query(effective_term, "gdc", QueryStatus.SUCCESS, len(records))

    return json.dumps({
        "source": "gdc",
        "term": effective_term,
        "project_ids": [r["project_id"] for r in records],
        "records": records,
    }, ensure_ascii=False)


@function_tool(
    description_override=(
        "Get detailed metadata about a GDC project. "
        "Parameters: ``project_id`` (required, e.g. 'TCGA-BRCA'), "
        "``data_category`` (optional, filters the returned data categories "
        "e.g. 'Transcriptome Profiling'). "
        "Returns project metadata including data categories and file counts."
    ),
)
async def describe_gdc(
    ctx: RunContextWrapper[Any],
    project_id: str,
    data_category: str | None = None,
) -> str:
    """Get detailed metadata about a GDC project.

    Calls /projects/{project_id} with summary expansion to return disease
    type, primary site, case and file counts, available data categories
    by file count, and experimental strategies.

    Args:
        ctx: Run context (injected by the OpenAI Agents SDK).
        project_id: GDC project identifier (e.g. "TCGA-LUAD",
                    "TARGET-AML", "CPTAC-3").
        data_category: Optional filter; when given, only data categories
            whose name contains this value (case-insensitive) are returned.

    Returns:
        JSON string with keys:
            source                  – "gdc"
            project_id              – GDC project identifier
            name                    – human-readable project name
            disease_type            – list of disease classifications
            primary_site            – list of anatomical sites
            program                 – parent program (TCGA, TARGET, …)
            case_count              – number of cases in the project
            file_count              – total files available
            data_categories         – [{category, file_count}, …]
            experimental_strategies – e.g. ["WXS", "RNA-Seq", …]
            dbgap_accession         – dbGaP accession if available
            state                   – "open" or "legacy"
            error                   – present only on failure
    """
    run_ctx: RunContext = ctx.context
    try:
        url = _build_url(f"/projects/{project_id}", {
            "format": "json",
            "expand": (
                "summary,summary.case_count,summary.file_count,"
                "summary.data_categories,summary.experimental_strategies"
            ),
        })
        data = await _fetch_json_for_run(run_ctx, url)
    except Exception as exc:
        # /projects/{id} returns HTTP 404 with {"message": "... not found"}
        # for unknown projects — surfaced here as a network-level exception.
        run_ctx.log_query(project_id, "gdc", QueryStatus.FAILED, 0)
        return json.dumps({
            "source": "gdc",
            "project_id": project_id,
            "error": str(exc),
        }, ensure_ascii=False)

    # /projects/{project_id} returns the project object directly under "data"
    # (NOT a hits[] array like the /projects collection endpoint).
    project_data: dict[str, Any] = data.get("data") or {}
    if not project_data or "project_id" not in project_data:
        run_ctx.log_query(project_id, "gdc", QueryStatus.FAILED, 0)
        return json.dumps({
            "source": "gdc",
            "project_id": project_id,
            "error": f"project '{project_id}' not found",
        }, ensure_ascii=False)

    summary: dict[str, Any] = project_data.get("summary", {}) or {}

    data_categories: list[dict[str, Any]] = []
    for dc in (summary.get("data_categories", []) or []):
        data_categories.append({
            "category": dc.get("data_category", ""),
            "file_count": dc.get("file_count", 0),
        })
    if data_category:
        needle = data_category.lower()
        data_categories = [
            dc for dc in data_categories if needle in dc["category"].lower()
        ]

    exp_strategies: list[str] = []
    for es in (summary.get("experimental_strategies", []) or []):
        exp_strategies.append(es.get("experimental_strategy", ""))

    run_ctx.log_query(project_id, "gdc", QueryStatus.SUCCESS, 1)
    return json.dumps({
        "source": "gdc",
        "project_id": project_data.get("project_id", project_id),
        "name": project_data.get("name", ""),
        "disease_type": project_data.get("disease_type", []),
        "primary_site": project_data.get("primary_site", []),
        "program": (project_data.get("program") or {}).get("name", ""),
        "case_count": summary.get("case_count", 0),
        "file_count": summary.get("file_count", 0),
        "data_categories": data_categories,
        "experimental_strategies": exp_strategies,
        "dbgap_accession": project_data.get("dbgap_accession_number", ""),
        "state": project_data.get("state", ""),
    }, ensure_ascii=False)


@function_tool(
    description_override=(
        "Download data files from a GDC project. "
        "Parameters: ``project_id`` (required, e.g. 'TCGA-PAAD'), "
        "``data_type`` (optional, default 'RNA-Seq'), "
        "``data_category`` (optional, e.g. 'Transcriptome Profiling'), "
        "``workflow_type`` (optional, e.g. 'STAR - Counts'). "
        "Downloads up to 5 matching files and writes a manifest."
    ),
)
async def download_gdc(
    ctx: RunContextWrapper[Any],
    project_id: str,
    data_type: str = "RNA-Seq",
    data_category: str | None = None,
    workflow_type: str | None = None,
) -> str:
    """Download data files from a GDC project via the Data Transfer API.

    Queries /files filtered by project and data type to build a manifest,
    saves it to the task raw directory, then downloads a representative
    sample (up to 5 files).  A SourceRecord is written to provenance so
    downstream tools can trace every file to its origin.

    Args:
        ctx: Run context (injected by the OpenAI Agents SDK).
        project_id: GDC project identifier (e.g. "TCGA-LUAD").
        data_type: Shorthand data type — supports "RNA-Seq", "miRNA-Seq",
                   "CNA" / "CNV", "Methylation", "Somatic" / "Mutation",
                   "Clinical", "Slide", "Biospecimen", or any raw GDC
                   data_type value.  Defaults to "RNA-Seq".
        data_category: Optional filter restricting results to a GDC data
            category (e.g. "Transcriptome Profiling").
        workflow_type: Optional filter restricting results to a GDC
            workflow type (e.g. "STAR - Counts").

    Returns:
        JSON string with keys:
            source       – "gdc"
            accession    – project_id
            data_type    – original data_type argument
            source_url   – files query URL used
            local_files  – paths under the task raw directory
            format_hint  – "gdc_<normalised_data_type>"
            file_count   – total matching files (from pagination)
            downloaded   – number of files actually saved
            retrieved_at – ISO-8601 timestamp
            error        – present only on failure
    """
    run_ctx: RunContext = ctx.context
    gdc_data_type = _normalize_data_type(data_type)

    # ------------------------------------------------------------------
    # Step 1 — query /files for matching file metadata
    # ------------------------------------------------------------------
    filters = {
        "op": "and",
        "content": [
            {
                "op": "=",
                "content": {
                    "field": "cases.project.project_id",
                    "value": [project_id],
                },
            },
            {
                "op": "=",
                "content": {
                    "field": "files.data_type",
                    "value": [gdc_data_type],
                },
            },
        ],
    }
    if data_category:
        filters["content"].append({
            "op": "=",
            "content": {
                "field": "files.data_category",
                "value": [data_category],
            },
        })
    if workflow_type:
        filters["content"].append({
            "op": "=",
            "content": {
                "field": "files.analysis.workflow_type",
                "value": [workflow_type],
            },
        })
    encoded_filters = json.dumps(filters, separators=(",", ":"))

    try:
        url = _build_url("/files", {
            "filters": encoded_filters,
            "format": "json",
            "size": "200",
        })
        data = await _fetch_json_for_run(run_ctx, url)
    except Exception as exc:
        return json.dumps({
            "source": "gdc",
            "accession": project_id,
            "error": str(exc),
        }, ensure_ascii=False)

    file_hits: list[dict[str, Any]] = data.get("data", {}).get("hits", [])
    pagination: dict[str, Any] = data.get("data", {}).get("pagination", {})
    total_files: int = pagination.get("total", len(file_hits))

    if not file_hits:
        return json.dumps({
            "source": "gdc",
            "accession": project_id,
            "data_type": data_type,
            "error": (
                f"no files found for project '{project_id}' with "
                f"data_type '{data_type}'"
            ),
            "file_count": 0,
        })

    # ------------------------------------------------------------------
    # Step 2 — build manifest
    # ------------------------------------------------------------------
    manifest: list[dict[str, Any]] = []
    for fh in file_hits:
        manifest.append({
            "file_id": fh.get("file_id", ""),
            "file_name": fh.get("file_name", ""),
            "data_type": fh.get("data_type", ""),
            "data_format": fh.get("data_format", ""),
            "data_category": fh.get("data_category", ""),
            "file_size": fh.get("file_size", 0),
            "md5sum": fh.get("md5sum", ""),
        })

    # Save manifest JSON to raw directory
    safe_dt = data_type.replace(" ", "_").replace("-", "_")
    manifest_filename = f"gdc_{project_id}_{safe_dt}_manifest.json"
    manifest_path = run_ctx.work_dir.raw / manifest_filename
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        json.dumps({
            "project_id": project_id,
            "data_type": data_type,
            "gdc_data_type": gdc_data_type,
            "total_files": total_files,
            "returned_files": len(manifest),
            "files": manifest,
        }, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    # ------------------------------------------------------------------
    # Step 3 — download a representative subset (up to 5 files)
    # ------------------------------------------------------------------
    local_files: list[str] = [
        str(run_ctx.work_dir.raw_file(manifest_filename)),
    ]

    download_limit = min(len(file_hits), 5)
    for _idx, fh in enumerate(file_hits[:download_limit]):
        file_uuid: str = fh.get("file_id", "")
        file_name: str = fh.get("file_name", "") or f"{file_uuid}.tsv"
        download_url = f"{_GDC_API_BASE}/data/{file_uuid}"

        if Path(file_name).name != file_name or file_name in {".", ".."}:
            run_ctx.add_warning(
                "warning",
                f"Skipped unsafe GDC filename {file_name!r}",
                "gdc",
            )
            continue
        try:
            if run_ctx.subagent_id is not None:
                facade = run_ctx.crawler_facade_or_none
                if facade is None:
                    raise RuntimeError("crawler facade is not bound to the child Run")
                result = await facade.download(download_url)
                if not result.ok:
                    raise RuntimeError(result.error or f"HTTP {result.status_code}")
                source_id = make_source_id(Database.GDC, project_id, download_url)
                asset = await asyncio.to_thread(
                    run_ctx.stage_source_asset,
                    content=result.content,
                    filename=file_name,
                    source_id=source_id,
                    successful_attempt_id=generate_prefixed_uuid("download_attempt"),
                    data_level=DataLevel.REPOSITORY_PROCESSED,
                    media_type="application/octet-stream",
                )
                local_files.append(str(run_ctx.source_asset_path(asset)))
            else:
                dest = run_ctx.work_dir.raw_file(file_name)
                await _download_file_for_run(run_ctx, download_url, dest)
                local_files.append(str(dest))
        except Exception as exc:
            logger.warning(
                "Failed to download GDC file %s (%s): %s",
                file_uuid, file_name, exc,
            )
            run_ctx.add_warning(
                "warning",
                f"Failed to download GDC file {file_uuid}: {exc}",
                "gdc",
            )

    # ------------------------------------------------------------------
    # Step 4 — record provenance
    # ------------------------------------------------------------------
    format_hint = f"gdc_{safe_dt.lower()}"

    # Register only the downloaded TSV data files (local_files[1:]); the
    # manifest JSON at local_files[0] is metadata, not raw data for processing.
    for data_file in local_files[1:]:
        run_ctx.add_raw_asset(data_file)

    retrieved_at = datetime.now(UTC)
    source_record = SourceRecord(
        source_id=make_source_id(Database.GDC, project_id, url),
        database=Database.GDC,
        accession=project_id,
        url=url,
        title=f"GDC project {project_id} ({data_type})",
        retrieved_at=retrieved_at,
    )
    run_ctx.add_source(source_record)

    downloaded_count = len(local_files) - 1
    response: dict[str, Any] = {
        "source": "gdc",
        "accession": project_id,
        "data_type": data_type,
        "source_url": url,
        "local_files": local_files,
        "format_hint": format_hint,
        "file_count": total_files,
        "downloaded": downloaded_count,
        "retrieved_at": retrieved_at.isoformat(),
    }
    if downloaded_count == 0:
        response["error"] = "failed to download any matching GDC data files"
    return json.dumps(response, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Skill registration
# ---------------------------------------------------------------------------

gdc_skill = SkillDef(
    name="gdc",
    category=SkillCategory.ACQUISITION,
    description=(
        "Search, describe, and download datasets from NCI Genomic Data "
        "Commons (GDC). Use when the user asks about TCGA, TARGET, CPTAC, "
        "cancer genomics, or needs raw transcriptomic / genomic / clinical "
        "data from GDC."
    ),
    instructions=(
        "Use the gdc tools to search the NCI GDC by keyword, inspect project "
        "metadata, and download data files (RNA-Seq, miRNA-Seq, CNA/CNV, "
        "methylation, somatic mutations, clinical supplements, slide images, "
        "or biospecimen data).  "
        "Prefer search_gdc to discover relevant projects, describe_gdc to "
        "inspect their metadata, and download_gdc to retrieve files.  "
        "All downloads are saved to the task raw directory and tracked in "
        "provenance so every file is traceable to its GDC origin."
    ),
    tools=[search_gdc, describe_gdc, download_gdc],
    supported_sources=["gdc", "tcga", "nci_gdc"],
    version="0.1.0",
)

skill_registry.register(gdc_skill)
