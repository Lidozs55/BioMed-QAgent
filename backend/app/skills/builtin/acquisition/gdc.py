"""GDC acquisition skill — search, describe, and download from NCI Genomic Data Commons."""
from __future__ import annotations

import json
import logging
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext
from app.domain.output import SourceRecord
from app.skills.registry import SkillCategory, SkillDef, skill_registry

logger = logging.getLogger(__name__)

_GDC_API_BASE = "https://api.gdc.cancer.gov"

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
    """Fetch and parse JSON from a GDC REST API endpoint."""
    with urllib.request.urlopen(url, timeout=30) as resp:
        return json.loads(resp.read().decode())


def _download_file(url: str, dest: Path) -> None:
    """Download a file to *dest*, atomically via a .part temp file."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    urllib.request.urlretrieve(url, tmp)
    if dest.exists():
        dest.unlink()
    tmp.rename(dest)


def _normalize_data_type(data_type: str) -> str:
    """Resolve a shorthand data type to its full GDC API name."""
    return _DATA_TYPE_MAP.get(data_type.strip().lower(), data_type.strip())

# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


@function_tool
def search_gdc(ctx: RunContextWrapper[Any], term: str, max_results: int = 20) -> str:
    """Search the NCI Genomic Data Commons for projects matching a keyword.

    Queries the /projects endpoint with summary expansion and then filters
    locally by matching *term* against project_id, name, disease_type, and
    primary_site.  Returns project-level metadata including case and file
    counts so the caller can decide which project to investigate further.

    The /cases endpoint is used indirectly via the project summary
    expansion to obtain case counts without additional round-trips.

    Args:
        ctx: Run context (injected by the OpenAI Agents SDK).
        term: Search keyword or phrase (e.g. "lung", "TCGA-LUAD",
              "breast invasive carcinoma").
        max_results: Maximum number of project records to return
                     (default 20).

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
    try:
        url = _build_url("/projects", {
            "format": "json",
            "size": "200",
            "expand": (
                "summary,summary.case_count,summary.file_count,"
                "summary.data_categories"
            ),
        })
        data = _fetch_json(url)
    except Exception as exc:
        run_ctx.log_query(term, "gdc", "error", 0)
        return json.dumps({
            "source": "gdc",
            "term": term,
            "project_ids": [],
            "records": [],
            "error": str(exc),
        })

    hits: list[dict[str, Any]] = data.get("data", {}).get("hits", [])
    term_lower = term.lower()
    records: list[dict[str, Any]] = []

    for hit in hits:
        pid: str = hit.get("project_id", "")
        name: str = hit.get("name", "")
        disease: list[str] = hit.get("disease_type") or []
        primary_site: list[str] = hit.get("primary_site") or []
        summary: dict[str, Any] = hit.get("summary", {}) or {}

        # Build searchable text from all human-readable fields
        search_text = " ".join([
            pid.lower(),
            name.lower(),
            *(d.lower() for d in disease),
            *(ps.lower() for ps in primary_site),
        ])
        if term_lower not in search_text:
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

    run_ctx.log_query(term, "gdc", "ok", len(records))

    return json.dumps({
        "source": "gdc",
        "term": term,
        "project_ids": [r["project_id"] for r in records],
        "records": records,
    })


@function_tool
def describe_gdc(ctx: RunContextWrapper[Any], project_id: str) -> str:
    """Get detailed metadata about a GDC project.

    Calls /projects/{project_id} with summary expansion to return disease
    type, primary site, case and file counts, available data categories
    by file count, and experimental strategies.

    Args:
        ctx: Run context (injected by the OpenAI Agents SDK).
        project_id: GDC project identifier (e.g. "TCGA-LUAD",
                    "TARGET-AML", "CPTAC-3").

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
    try:
        url = _build_url(f"/projects/{project_id}", {
            "format": "json",
            "expand": (
                "summary,summary.case_count,summary.file_count,"
                "summary.data_categories,summary.experimental_strategies"
            ),
        })
        data = _fetch_json(url)
    except Exception as exc:
        return json.dumps({
            "source": "gdc",
            "project_id": project_id,
            "error": str(exc),
        })

    hits: list[dict[str, Any]] = data.get("data", {}).get("hits", [])
    if not hits:
        return json.dumps({
            "source": "gdc",
            "project_id": project_id,
            "error": f"project '{project_id}' not found",
        })

    hit = hits[0]
    summary: dict[str, Any] = hit.get("summary", {}) or {}

    data_categories: list[dict[str, Any]] = []
    for dc in (hit.get("summary", {}).get("data_categories", []) or []):
        data_categories.append({
            "category": dc.get("data_category", ""),
            "file_count": dc.get("file_count", 0),
        })

    exp_strategies: list[str] = []
    for es in (hit.get("summary", {}).get("experimental_strategies", []) or []):
        exp_strategies.append(es.get("experimental_strategy", ""))

    return json.dumps({
        "source": "gdc",
        "project_id": hit.get("project_id", project_id),
        "name": hit.get("name", ""),
        "disease_type": hit.get("disease_type", []),
        "primary_site": hit.get("primary_site", []),
        "program": (hit.get("program") or {}).get("name", ""),
        "case_count": summary.get("case_count", 0),
        "file_count": summary.get("file_count", 0),
        "data_categories": data_categories,
        "experimental_strategies": exp_strategies,
        "dbgap_accession": hit.get("dbgap_accession_number", ""),
        "state": hit.get("state", ""),
    })


@function_tool
def download_gdc(
    ctx: RunContextWrapper[Any],
    project_id: str,
    data_type: str = "RNA-Seq",
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
    encoded_filters = json.dumps(filters, separators=(",", ":"))

    try:
        url = _build_url("/files", {
            "filters": encoded_filters,
            "format": "json",
            "size": "200",
        })
        data = _fetch_json(url)
    except Exception as exc:
        return json.dumps({
            "source": "gdc",
            "accession": project_id,
            "error": str(exc),
        })

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

        dest = run_ctx.work_dir.raw / file_name
        try:
            _download_file(download_url, dest)
            local_files.append(str(run_ctx.work_dir.raw_file(file_name)))
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

    if local_files:
        run_ctx.add_raw_asset(local_files[0])

    source_record = SourceRecord(
        source="gdc",
        accession=project_id,
        source_url=url,
        local_files=local_files,
        format_hint=format_hint,
    )
    run_ctx.add_source(source_record)

    return json.dumps({
        "source": "gdc",
        "accession": project_id,
        "data_type": data_type,
        "source_url": url,
        "local_files": local_files,
        "format_hint": format_hint,
        "file_count": total_files,
        "downloaded": download_limit,
        "retrieved_at": source_record.retrieved_at.isoformat(),
    })


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
