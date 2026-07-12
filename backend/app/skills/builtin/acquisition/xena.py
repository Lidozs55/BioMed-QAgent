"""UCSC Xena acquisition skill — search and download public genomics datasets from the Xena data hub."""
from __future__ import annotations

import gzip
import json
import logging
import re
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext
from app.domain.output import SourceRecord
from app.skills.registry import SkillCategory, SkillDef, skill_registry

logger = logging.getLogger(__name__)

_XENA_HUB_BASE = "https://toil-xena-hub.s3.us-east-1.amazonaws.com"
_XENA_DOWNLOAD_BASE = f"{_XENA_HUB_BASE}/download"

# Known dataset type patterns for categorization
_DATASET_TYPE_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("gene_expression", re.compile(r"gene.?expr|HiSeq|RNA.?seq|fpkm|tpm|rsem", re.IGNORECASE)),
    ("clinical", re.compile(r"clinical|phenotype|survival|follow.?up", re.IGNORECASE)),
    ("mutation", re.compile(r"mutation|mutect|varscan|muse|somaticsniper", re.IGNORECASE)),
    ("copy_number", re.compile(r"copy.?number|cnv|gistic|seg", re.IGNORECASE)),
    ("methylation", re.compile(r"methylation|hm450|hm27|450k", re.IGNORECASE)),
    ("mirna", re.compile(r"miRNA|mirna|mirseq", re.IGNORECASE)),
    ("protein", re.compile(r"protein|rppa|proteome", re.IGNORECASE)),
    ("somatic_mutation", re.compile(r"masked.?somatic", re.IGNORECASE)),
    ("pathway", re.compile(r"pathway|paradi[gm]", re.IGNORECASE)),
    ("signature", re.compile(r"signature|stemness|immune", re.IGNORECASE)),
    ("fusion", re.compile(r"fusion|star.?fusion", re.IGNORECASE)),
    ("immune", re.compile(r"immune|lymphocyte|leukocyte|stromal", re.IGNORECASE)),
]


def _classify_dataset_type(name: str) -> str:
    """Infer a dataset type label from its name."""
    for label, pat in _DATASET_TYPE_PATTERNS:
        if pat.search(name):
            return label
    return "other"


def _extract_cohort(name: str) -> str:
    """Extract a cohort/project identifier from a dataset name.

    Typical Xena naming: TCGA.BRCA.sampleMap/HiSeqV2.gz → TCGA-BRCA
    """
    # Try TCGA-like prefix
    m = re.match(r"(TCGA\.[A-Z0-9]+)", name, re.IGNORECASE)
    if m:
        return m.group(1).upper()
    # Try TARGET-like prefix
    m = re.match(r"(TARGET[\-\_][A-Z0-9]+)", name, re.IGNORECASE)
    if m:
        return m.group(1).upper()
    # Try GTEx-like prefix
    m = re.match(r"(GTEx)", name, re.IGNORECASE)
    if m:
        return "GTEx"
    # Generic: first segment before dot or slash
    m = re.match(r"([A-Za-z0-9_\-]+)", name)
    if m:
        return m.group(1).upper()
    return "unknown"


def _fetch_hub_index() -> list[dict[str, Any]]:
    """Fetch and parse the S3 XML listing from the Xena public data hub.

    Returns a list of dataset metadata dicts with keys:
        dataset_id, name, type, cohort, size_bytes, last_modified
    """
    request = urllib.request.Request(
        _XENA_DOWNLOAD_BASE,
        headers={"User-Agent": "BioMed-QAgent/0.1"},
    )

    with urllib.request.urlopen(request, timeout=60) as resp:
        root_xml = ET.parse(resp).getroot()
    ns = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
    contents = root_xml.findall("s3:Contents", ns)

    datasets: dict[str, dict[str, Any]] = {}

    for item in contents:
        key_el = item.find("s3:Key", ns)
        if key_el is None:
            continue
        key = key_el.text or ""
        if not key or key.endswith("/"):
            continue

        # Derive dataset_id — strip .gz if present for the canonical ID
        dataset_id = key
        if dataset_id.endswith(".gz"):
            dataset_id = dataset_id[:-3]

        # Skip metadata/hub descriptor files
        lower = key.lower()
        if lower in ("hub.txt", "genomes.txt", "hub.json", "index.html"):
            continue

        name = key.rsplit(".", 1)[0] if "." in key else key
        if name.endswith(".tsv"):
            name = name[:-4]

        size_el = item.find("s3:Size", ns)
        mod_el = item.find("s3:LastModified", ns)
        size_bytes = int(size_el.text) if size_el is not None and size_el.text else 0
        last_modified = mod_el.text if mod_el is not None and mod_el.text else ""

        datasets[dataset_id] = {
            "dataset_id": dataset_id,
            "name": name,
            "type": _classify_dataset_type(name),
            "cohort": _extract_cohort(name),
            "size_bytes": size_bytes,
            "last_modified": last_modified,
        }

    return list(datasets.values())


def _match_term(record: dict[str, Any], term: str) -> bool:
    """Check if term matches dataset name, type, cohort, or ID."""
    lower_term = term.lower()
    for field in ("name", "type", "cohort", "dataset_id"):
        val = str(record.get(field, "")).lower()
        if lower_term in val:
            return True
    return False


def _download(url: str, dest: Path) -> None:
    """Download a file to dest via urllib, using a .part temp file."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "BioMed-QAgent/0.1"},
    )
    urllib.request.urlretrieve(url, tmp)
    if dest.exists():
        dest.unlink()
    tmp.rename(dest)


def _decompress_gz(path: Path) -> Path:
    """Decompress a .gz file, returning the output path."""
    out = path.with_suffix("")
    with gzip.open(path, "rb") as src, open(out, "wb") as dst:
        dst.write(src.read())
    return out


@function_tool
def search_xena(ctx: RunContextWrapper[Any], term: str, max_results: int = 20) -> str:
    """Search UCSC Xena public hub datasets by term.

    Fetches the S3 XML directory listing from the Xena hub, parses available
    dataset files, and filters those matching *term* against name, type, cohort,
    and dataset ID.

    Args:
        ctx: Agent SDK run context wrapper.
        term: Search keyword or phrase (e.g. "BRCA", "mutation", "clinical").
        max_results: Maximum number of matching datasets to return (default 20).

    Returns:
        JSON string with keys: source, term, count, records.
    """
    run_ctx: RunContext = ctx.context
    try:
        all_datasets = _fetch_hub_index()
    except Exception as exc:
        run_ctx.log_query(term, "xena", "error", 0)
        return json.dumps({
            "source": "xena",
            "term": term,
            "count": 0,
            "records": [],
            "error": str(exc),
        })

    # Filter by term — substring match across relevant fields
    if term.strip():
        matched = [d for d in all_datasets if _match_term(d, term.strip())]
    else:
        matched = all_datasets

    count = len(matched)
    run_ctx.log_query(term, "xena", "ok", count)

    return json.dumps({
        "source": "xena",
        "term": term,
        "count": count,
        "records": matched[:max_results],
    })


@function_tool
def download_xena(
    ctx: RunContextWrapper[Any],
    dataset_id: str,
    file_type: str = "tsv",
) -> str:
    """Download a specific UCSC Xena dataset file.

    Constructs the URL as:
    ``https://toil-xena-hub.s3.us-east-1.amazonaws.com/download/{dataset_id}.{file_type}.gz``,
    downloads the compressed file into the task raw directory, decompresses it,
    and records the download via provenance (SourceRecord).

    Args:
        ctx: Agent SDK run context wrapper.
        dataset_id: Dataset identifier as returned by search_xena
            (e.g. "TCGA.BRCA.sampleMap/HiSeqV2.gz" or
            "probeMap%2Fhugo_gencode_good_hg19_V24lift37.gz").
        file_type: File extension without `.gz` — usually "tsv" (default) or "json".

    Returns:
        JSON with source, dataset_id, source_url, local_files, format_hint,
        and retrieved_at (ISO-8601).
    """
    run_ctx: RunContext = ctx.context
    file_type = file_type.lower().strip().lstrip(".")

    # Build the canonical dataset ID — ensure it ends with .{file_type}.gz
    base_id = dataset_id
    # If the id already ends with .gz, strip it; we re-append
    if base_id.endswith(".gz"):
        base_id = base_id[:-3]
    # If base_id ends with .tsv or .json, strip that too
    for ext in (".tsv", ".json"):
        if base_id.endswith(ext):
            base_id = base_id[:-len(ext)]
            break

    remote_filename = f"{base_id}.{file_type}.gz"
    url = f"{_XENA_DOWNLOAD_BASE}/{remote_filename}"

    local_gz = run_ctx.work_dir.raw / remote_filename

    try:
        _download(url, local_gz)
    except Exception as exc:
        return json.dumps({
            "source": "xena",
            "dataset_id": dataset_id,
            "error": f"download failed: {exc}",
        })

    try:
        decompressed = _decompress_gz(local_gz)
    except Exception as exc:
        return json.dumps({
            "source": "xena",
            "dataset_id": dataset_id,
            "source_url": url,
            "local_files": [str(local_gz)],
            "error": f"decompression failed: {exc}",
        })

    local_files = [str(local_gz), str(decompressed)]

    run_ctx.add_raw_asset(local_files[0])

    source_record = SourceRecord(
        source="xena",
        accession=dataset_id,
        source_url=url,
        local_files=local_files,
        format_hint=f"xena_{file_type}",
    )
    run_ctx.add_source(source_record)

    return json.dumps({
        "source": "xena",
        "dataset_id": dataset_id,
        "source_url": url,
        "local_files": local_files,
        "format_hint": f"xena_{file_type}",
        "retrieved_at": source_record.retrieved_at.isoformat(),
    })


xena_skill = SkillDef(
    name="xena",
    category=SkillCategory.ACQUISITION,
    description=(
        "Search, browse, and download public genomics datasets from the UCSC Xena "
        "data hub. Use when the user asks about Xena, TCGA cohorts, cancer genomics "
        "data, or needs gene expression / clinical / mutation datasets from Xena."
    ),
    instructions=(
        "Use the xena tools to search the UCSC Xena public data hub by keyword, "
        "inspect available datasets by cohort or type, and download specific dataset "
        "files (.tsv.gz or .json). "
        "Prefer search_xena to discover datasets by term (e.g. cohort name, data type), "
        "and download_xena to retrieve individual files. "
        "All downloads go to the task raw directory and are tracked in provenance."
    ),
    tools=[search_xena, download_xena],
    supported_sources=["xena", "ucsc_xena"],
    version="0.1.0",
)

skill_registry.register(xena_skill)
