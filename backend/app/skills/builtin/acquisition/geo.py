"""GEO acquisition skill — search metadata and download raw files from NCBI GEO."""
from __future__ import annotations

import gzip
import json
import logging
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

import GEOparse
from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext
from app.domain.output import SourceRecord
from app.skills.registry import SkillCategory, SkillDef, skill_registry

logger = logging.getLogger(__name__)

_GEO_SEARCH_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
_GEO_FTP_BASE = "https://ftp.ncbi.nlm.nih.gov/geo"


def _geo_search_url(term: str, max_results: int = 20) -> str:
    return (
        f"{_GEO_SEARCH_BASE}?db=gds&term={urllib.parse.quote(term)}"
        f"&retmax={max_results}&retmode=json"
    )


def _fetch_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=30) as resp:
        return json.loads(resp.read().decode())


def _build_matrix_url(accession: str) -> str:
    prefix = accession[:5].lower()
    return (
        f"{_GEO_FTP_BASE}/series/{prefix}nnn/{accession}"
        f"/matrix/{accession}_series_matrix.txt.gz"
    )


def _build_soft_url(accession: str) -> str:
    prefix = accession[:5].lower()
    family = "gse" if accession.lower().startswith("gse") else "gsm"
    return (
        f"{_GEO_FTP_BASE}/{family}data/{prefix}nnn"
        f"/{accession}/{accession}_family.soft.gz"
    )


def _download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    urllib.request.urlretrieve(url, tmp)
    if dest.exists():
        dest.unlink()
    tmp.rename(dest)


def _decompress_gz(path: Path) -> Path:
    out = path.with_suffix("")
    with gzip.open(path, "rb") as src, open(out, "wb") as dst:
        dst.write(src.read())
    return out


@function_tool
def search_geo(ctx: RunContextWrapper[Any], term: str, max_results: int = 20) -> str:
    run_ctx: RunContext = ctx.context
    try:
        url = _geo_search_url(term, max_results=max_results)
        data = _fetch_json(url)
    except Exception as exc:
        run_ctx.log_query(term, "geo", "error", 0)
        return json.dumps({
            "source": "geo",
            "term": term,
            "accessions": [],
            "records": [],
            "error": str(exc),
        })

    ids = data.get("esearchresult", {}).get("idlist", [])
    run_ctx.log_query(term, "geo", "ok", len(ids))

    records: list[dict[str, Any]] = []
    for geo_id in ids[:max_results]:
        try:
            gse = GEOparse.get_GEO(geo_id, silent=True, destdir=run_ctx.work_dir.raw)
        except Exception:
            continue
        records.append({
            "accession": getattr(gse, "accession", geo_id),
            "title": getattr(gse, "title", ""),
            "summary": getattr(gse, "summary", "") or getattr(gse, "abstract", ""),
            "organism": getattr(gse, "organism", ""),
            "platform_count": len(getattr(gse, "platforms", {}) or {}),
            "sample_count": len(getattr(gse, "sample", {}) or {}),
            "pubmed_id": getattr(gse, "pubmed_id", ""),
        })

    return json.dumps({
        "source": "geo",
        "term": term,
        "accessions": [r["accession"] for r in records],
        "records": records,
    })


@function_tool
def describe_geo(ctx: RunContextWrapper[Any], accession: str) -> str:
    run_ctx: RunContext = ctx.context
    try:
        gse = GEOparse.get_GEO(accession, silent=True, destdir=run_ctx.work_dir.raw)
    except Exception as exc:
        return json.dumps({
            "source": "geo",
            "accession": accession,
            "error": str(exc),
        })

    platforms = []
    if hasattr(gse, "platforms") and gse.platforms:
        for k, v in gse.platforms.items():
            platforms.append({
                "id": k,
                "title": getattr(v, "title", ""),
                "organism": getattr(v, "organism", ""),
            })

    samples = []
    if hasattr(gse, "sample") and gse.sample:
        for k, v in list(gse.sample.items())[:10]:
            samples.append({
                "id": k,
                "title": getattr(v, "title", ""),
                "organism": getattr(v, "organism", ""),
            })

    supp = []
    if hasattr(gse, "supplementary_files") and gse.supplementary_files:
        supp = [str(f) for f in gse.supplementary_files]

    return json.dumps({
        "source": "geo",
        "accession": accession,
        "title": getattr(gse, "title", ""),
        "summary": getattr(gse, "summary", "") or getattr(gse, "abstract", ""),
        "overall_design": getattr(gse, "overall_design", ""),
        "organism": getattr(gse, "organism", ""),
        "platforms": platforms,
        "sample_count": len(getattr(gse, "sample", {}) or {}),
        "pubmed_ids": getattr(gse, "pubmed_id", ""),
        "supplementary_file_urls": supp,
    })


@function_tool
def download_geo(ctx: RunContextWrapper[Any], accession: str, file_type: str = "matrix") -> str:
    run_ctx: RunContext = ctx.context
    file_type = file_type.lower().strip()
    url: str = ""
    local_files: list[str] = []
    format_hint: str = ""

    if file_type == "matrix":
        url = _build_matrix_url(accession)
        filename = f"{accession}_series_matrix.txt.gz"
        dest = run_ctx.work_dir.raw / filename
        try:
            _download(url, dest)
        except Exception as exc:
            return json.dumps({
                "source": "geo",
                "accession": accession,
                "error": str(exc),
            })
        _decompress_gz(dest)
        local_files = [
            str(run_ctx.work_dir.raw_file(filename)),
            str(run_ctx.work_dir.raw_file(filename.replace(".gz", ""))),
        ]
        format_hint = "geo_series_matrix"

    elif file_type == "soft":
        url = _build_soft_url(accession)
        filename = f"{accession}_family.soft.gz"
        dest = run_ctx.work_dir.raw / filename
        try:
            _download(url, dest)
        except Exception as exc:
            return json.dumps({
                "source": "geo",
                "accession": accession,
                "error": str(exc),
            })
        _decompress_gz(dest)
        local_files = [
            str(run_ctx.work_dir.raw_file(filename)),
            str(run_ctx.work_dir.raw_file(filename.replace(".gz", ""))),
        ]
        format_hint = "geo_soft"

    elif file_type == "suppl":
        try:
            gse = GEOparse.get_GEO(accession, silent=True, destdir=run_ctx.work_dir.raw)
        except Exception as exc:
            return json.dumps({
                "source": "geo",
                "accession": accession,
                "error": str(exc),
            })

        supp_files = getattr(gse, "supplementary_files", [])
        target = None
        for f in supp_files:
            lower = str(f).lower()
            if lower.endswith((".txt", ".tsv", ".csv", ".txt.gz", ".tsv.gz", ".csv.gz")):
                target = str(f)
                break

        if not target:
            return json.dumps({
                "source": "geo",
                "accession": accession,
                "error": "no supplementary files found",
            })

        filename = Path(target).name
        dest = run_ctx.work_dir.raw / filename
        try:
            _download(target, dest)
        except Exception as exc:
            return json.dumps({
                "source": "geo",
                "accession": accession,
                "error": str(exc),
            })
        _decompress_gz(dest)
        local_files = [str(run_ctx.work_dir.raw_file(filename))]
        if dest.with_suffix("").exists():
            local_files.append(str(run_ctx.work_dir.raw_file(dest.with_suffix("").name)))
        url = target
        format_hint = "geo_supplementary"

    else:
        return json.dumps({
            "source": "geo",
            "accession": accession,
            "error": f"unsupported file_type: {file_type}",
        })

    if local_files:
        run_ctx.add_raw_asset(local_files[0])

    source_record = SourceRecord(
        source="geo",
        accession=accession,
        source_url=url,
        local_files=local_files,
        format_hint=format_hint,
    )
    run_ctx.add_source(source_record)

    return json.dumps({
        "source": "geo",
        "accession": accession,
        "source_url": url,
        "local_files": local_files,
        "format_hint": format_hint,
        "retrieved_at": source_record.retrieved_at.isoformat(),
    })


geo_skill = SkillDef(
    name="geo",
    category=SkillCategory.ACQUISITION,
    description="Search, describe, and download GEO (NCBI Gene Expression Omnibus) datasets. Use when user asks about GEO series, gene expression data, or needs raw GEO files.",
    instructions=(
        "Use the geo tools to search NCBI GEO by keyword, inspect dataset metadata, "
        "and download raw series matrix or SOFT files. "
        "Prefer search_geo to find datasets, describe_geo to inspect metadata, "
        "and download_geo to retrieve files. "
        "All downloads go to the task raw directory and are tracked in provenance."
    ),
    tools=[search_geo, describe_geo, download_geo],
    supported_sources=["geo", "ncbi_geo"],
    version="0.1.0",
)

skill_registry.register(geo_skill)
