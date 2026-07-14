"""Literature understanding skill — analyze paper abstracts/summaries to extract
structured data clues (databases, accessions, data types, species, links).

Uses deterministic regex-based extraction; no LLM or network calls.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext
from app.skills.registry import SkillCategory, SkillDef, skill_registry

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Regex patterns
# ---------------------------------------------------------------------------

_ACCESSION_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("GSE", re.compile(r"\bGSE\d{4,}\b")),
    ("GSM", re.compile(r"\bGSM\d{4,}\b")),
    ("GPL", re.compile(r"\bGPL\d{4,}\b")),
    ("SR[APX]", re.compile(r"\bSR[APX]\d{6,}\b")),
    ("E-MTAB", re.compile(r"\bE-MTAB-\d+\b")),
    ("PRJ[EDN]", re.compile(r"\bPRJ[EDN]\w+\b")),
    ("phs", re.compile(r"\bphs\d+\b")),
    ("PDB", re.compile(r"\bPDB\s+\w{4}\b", re.IGNORECASE)),
]

_DATA_TYPES: list[str] = [
    "RNA-seq", "microarray", "ChIP-seq", "WGS", "WES",
    "scRNA-seq", "proteomics", "metabolomics", "methylation",
    "ATAC-seq", "single-cell RNA-seq",
]

_SPECIES: list[str] = [
    "human", "mouse", "rat", "zebrafish", "drosophila",
    "c. elegans", "yeast", "fruit fly", "arabidopsis",
]

_KEYWORDS: list[str] = [
    "deposited in", "available at", "accession number",
    "GEO accession", "supplementary data", "supplementary material",
]

_URL_PATTERN = re.compile(r"https?://\S+")


def _extract(text: str, pattern: re.Pattern) -> list[str]:
    matches = pattern.findall(text)
    return list(dict.fromkeys(m for m in matches if m))


def _find_accessions(text: str) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    for label, pat in _ACCESSION_PATTERNS:
        hits = _extract(text, pat)
        if hits:
            result[label] = hits
    return result


def _find_species(text: str) -> list[str]:
    found: list[str] = []
    lower = text.lower()
    for sp in _SPECIES:
        if sp.lower() in lower:
            found.append(sp)
    return list(dict.fromkeys(found))


def _find_data_types(text: str) -> list[str]:
    found: list[str] = []
    lower = text.lower()
    for dt in _DATA_TYPES:
        if dt.lower() in lower:
            found.append(dt)
    return list(dict.fromkeys(found))


def _find_keywords(text: str) -> list[str]:
    found: list[str] = []
    lower = text.lower()
    for kw in _KEYWORDS:
        if kw.lower() in lower:
            found.append(kw)
    return list(dict.fromkeys(found))


def _find_supplementary_links(text: str) -> list[str]:
    urls = _extract(text, _URL_PATTERN)
    return [u for u in urls if any(k in u.lower() for k in
                                    ("supplement", "supplementary", "data portal", "github",
                                     "geo", "gdc", "tcga", "xena", "ega", "pride",
                                     "metabolights", "arrayexpress"))]


def _analyze_record(record: dict[str, Any]) -> dict[str, Any]:
    title = record.get("title", "") or ""
    abstract = record.get("abstract", "") or ""
    combined = f"{title} {abstract}".strip()
    if not combined:
        return _empty_finding(record)

    # --- databases ---
    db_map: dict[str, list[str]] = {}
    db_names = ["GEO", "GDC", "TCGA", "Xena", "PDB", "ArrayExpress",
                "SRA", "EGA", "dbGaP", "PRIDE", "MetaboLights"]
    for db_name in db_names:
        pat = re.compile(rf"\b{re.escape(db_name)}\b", re.IGNORECASE)
        if pat.search(combined):
            acc_pat = _ACCESSION_PATTERNS_BY_DB.get(db_name)
            accessions = _extract(combined, acc_pat) if acc_pat else []
            db_map[db_name] = accessions

    databases_found = [
        {"name": k, "accessions": v, "confidence": "high" if v else "medium"}
        for k, v in db_map.items()
    ]

    # --- query suggestions ---
    suggestions: list[str] = []
    for acc_list in db_map.values():
        suggestions.extend(acc_list[:2])
    for token in _find_keywords(combined):
        suggestions.append(token)
    suggestions = list(dict.fromkeys(suggestions))[:10]

    return {
        "pmid": record.get("pmid", ""),
        "doi": record.get("doi", ""),
        "databases_found": databases_found,
        "data_types": _find_data_types(combined),
        "species": _find_species(combined),
        "supplementary_links": _find_supplementary_links(combined),
        "keywords": _find_keywords(combined),
        "query_suggestions": suggestions,
    }


_ACCESSION_PATTERNS_BY_DB: dict[str, re.Pattern] = {
    "GEO": re.compile(r"\b(GSE\d{4,}|GSM\d{4,}|GPL\d{4,})\b"),
    "GDC": re.compile(r"\bGDC_\w+\b"),
    "TCGA": re.compile(r"\b(TCGA-[A-Z0-9]{2,}-[A-Z0-9]+)\b"),
    "PDB": re.compile(r"\b[0-9][A-Za-z0-9]{3}\b"),  # PDB ID: digit + 3 alnum
    "ArrayExpress": re.compile(r"\bE-MTAB-\d+\b"),
    "SRA": re.compile(r"\bSR[APX]\d{6,}\b"),
    "EGA": re.compile(r"\b(EGAD\d+|EGAS\d+)\b"),
    "dbGaP": re.compile(r"\bphs\d+\b"),
    "PRIDE": re.compile(r"\b(PXD\d+|PRIDE-\d+)\b"),
    "MetaboLights": re.compile(r"\bMTBLS\d+\b"),
}


def _empty_finding(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "pmid": record.get("pmid", ""),
        "doi": record.get("doi", ""),
        "databases_found": [],
        "data_types": [],
        "species": [],
        "supplementary_links": [],
        "keywords": [],
        "query_suggestions": [],
    }


# ---------------------------------------------------------------------------
# Tool
# ---------------------------------------------------------------------------

@function_tool(
    name_override="analyze_papers",
    description_override=(
        "Analyze paper abstracts and titles to extract structured data clues: "
        "database names, accession numbers, data types, species, supplementary "
       "material links, and actionable query suggestions. Input is a JSON string "
        "of the form {\"records\": [{\"title\": ..., \"abstract\": ..., "
        "\"doi\": ..., \"pmid\": ...}]}. "
       "Returns structured JSON with findings per paper plus a cross-paper summary."
    ),
)
def analyze_papers(
    ctx: RunContextWrapper[RunContext],
    papers_json: str,
) -> str:
    """Extract structured data clues from literature records using regex.

    Args:
        ctx: Run context (injected by the SDK, not exposed to the LLM).
        papers_json: JSON string like
            ``{"records": [{"title":..., "abstract":..., "doi":..., "pmid":...}]}``.
    """
    run_ctx: RunContext = ctx.context

    try:
        payload = json.loads(papers_json)
    except json.JSONDecodeError as exc:
        return json.dumps({"error": f"Invalid JSON input: {exc}"}, ensure_ascii=False)

    records: list[dict[str, Any]] = payload.get("records", [])
    if not records:
        return json.dumps({
            "papers_analyzed": 0,
            "findings": [],
            "summary": {
                "databases_referenced": [],
                "total_accessions_found": 0,
                "primary_data_types": [],
            },
        }, ensure_ascii=False)

    findings: list[dict[str, Any]] = []
    all_databases: list[str] = []
    all_accessions: list[str] = []
    all_data_types: list[str] = []
    errors: list[dict[str, Any]] = []

    try:
        for rec in records:
            try:
                finding = _analyze_record(rec)
            except Exception as exc:
                errors.append({"record": rec, "error": str(exc)})
                continue
            findings.append(finding)
            for db in finding["databases_found"]:
                all_databases.append(db["name"])
                all_accessions.extend(db["accessions"])
            all_data_types.extend(finding["data_types"])
    except Exception as exc:
        return json.dumps(
            {"status": "error", "error": str(exc), "partial_findings": findings},
            ensure_ascii=False,
        )

    databases_referenced = list(dict.fromkeys(all_databases))
    primary_data_types = list(dict.fromkeys(all_data_types))

    result = {
        "papers_analyzed": len(records),
        "findings": findings,
        "errors": errors,
        "summary": {
            "databases_referenced": databases_referenced,
            "total_accessions_found": len(all_accessions),
            "primary_data_types": primary_data_types,
        },
    }

    run_ctx.log_query(
        query="analyze_papers",
        source="literature_understanding",
        status="completed",
        records_count=len(records),
    )

    return json.dumps(result, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Skill definition & registration
# ---------------------------------------------------------------------------

lit_understanding_skill = SkillDef(
    name="literature_understanding",
    category=SkillCategory.DISCOVERY,
    description=(
        "Analyze paper abstracts/summaries to identify databases, accessions, "
        "data types, species, and supplementary material links for downstream "
        "data retrieval."
    ),
    instructions=(
        "The `analyze_papers` tool takes a JSON string of paper records "
        "(title, abstract, doi, pmid) and returns structured findings: "
        "database names with accessions, data types, species, supplementary "
        "links, keywords, and query suggestions. "
        "Use it after a literature search step to turn free-text abstracts into "
        "actionable data retrieval targets. "
        "Supported source contexts: PubMed, CrossRef, arXiv."
    ),
    tools=[analyze_papers],
    supported_sources=["pubmed", "crossref", "arxiv"],
    version="0.1.0",
)

skill_registry.register(lit_understanding_skill)
