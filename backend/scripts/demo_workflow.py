#!/usr/bin/env python3
"""BioMed-QAgent end-to-end demo pipeline.

Runs the complete workflow — PubMed search → paper analysis → GEO search →
GEO download → statistics — and produces a full output bundle (CSV, field
docs, source manifest, processing log, metrics JSON).

Two execution modes:
    - **Real**: Uses the Agent Runner + actual NCBI Entrez tools when
      ``DASHSCOPE_API_KEY`` is set. Requires network access.
    - **Mock** (fallback): Uses hardcoded mock PubMed + GEO data when no API
      key is available. Produces the same output structure without any
      external service calls.

Usage::

    cd backend
    uv run python scripts/demo_workflow.py

Output directory: ``data/demo_output/``
"""

from __future__ import annotations

import asyncio
import csv
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Ensure the backend package root is on sys.path so ``app.*`` imports work.
# ---------------------------------------------------------------------------
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

import app.config  # noqa: E402  — loads .env
from app.agent_loop.agent import create_agent  # noqa: E402
from app.agent_loop.context import RunContext  # noqa: E402
from app.core.metrics import MetricsTracker  # noqa: E402
from app.domain.output import (  # noqa: E402
    DataRecord,
    FieldDescription,
    OutputBundle,
    SourceRecord,
    WarningEntry,
)
from app.tools.export import export_bundle  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("demo_workflow")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

TOPIC = "breast cancer gene expression"
TASK_ID = "demo-001"
OUTPUT_DIR = _PROJECT_ROOT / "data" / "demo_output"

MOCK_PUBMED_RECORDS: list[dict[str, Any]] = [
    {
        "title": "Gene expression profiling of breast cancer subtypes",
        "abstract": (
            "We performed RNA-seq on 1,000 breast cancer samples and "
            "identified distinct expression signatures for luminal A, "
            "luminal B, HER2-enriched, and basal-like subtypes."
        ),
        "authors": "Smith J; Doe A; Lee K",
        "journal": "Nature Genetics",
        "pub_date": "2024-03",
        "doi": "10.1038/ng.2024.001",
        "pmid": "39900123",
        "pmcid": "PMC11000001",
        "is_open_access": True,
    },
    {
        "title": "Integrative analysis of breast cancer transcriptomes",
        "abstract": (
            "This study integrates transcriptome data from TCGA and METABRIC "
            "cohorts to reveal novel prognostic biomarkers."
        ),
        "authors": "Garcia M; Chen W; Park S",
        "journal": "Cancer Research",
        "pub_date": "2023-11",
        "doi": "10.1158/cr.2023.002",
        "pmid": "38800122",
        "pmcid": "PMC12000002",
        "is_open_access": True,
    },
    {
        "title": "Single-cell analysis of tumor microenvironment in breast cancer",
        "abstract": (
            "scRNA-seq of 50,000 cells from 10 breast cancer patients reveals "
            "immune cell heterogeneity and novel checkpoint targets."
        ),
        "authors": "Wang L; Zhang Y; Brown R",
        "journal": "Cell",
        "pub_date": "2024-06",
        "doi": "10.1016/j.cell.2024.003",
        "pmid": "37700133",
        "pmcid": "PMC13000003",
        "is_open_access": True,
    },
]

MOCK_GEO_RECORDS: list[dict[str, Any]] = [
    {
        "accession": "GSE200001",
        "title": "RNA-seq profiling of 100 breast cancer tumors",
        "summary": "100 breast cancer tumor samples profiled by RNA-seq",
        "organism": "Homo sapiens",
        "platform_count": 1,
        "sample_count": 100,
        "pubmed_id": "39900123",
    },
    {
        "accession": "GSE200002",
        "title": "Microarray analysis of breast cancer cell lines",
        "summary": "Gene expression in MCF7, MDA-MB-231, and T47D cell lines",
        "organism": "Homo sapiens",
        "platform_count": 2,
        "sample_count": 24,
        "pubmed_id": "38800122",
    },
]

MOCK_EXPRESSION_DATA: list[dict[str, Any]] = [
    {"gene": "ESR1", "log2FC": 3.21, "p_value": 0.0001, "subtype": "luminal"},
    {"gene": "PGR", "log2FC": 2.87, "p_value": 0.0003, "subtype": "luminal"},
    {"gene": "ERBB2", "log2FC": 4.15, "p_value": 0.00001, "subtype": "HER2"},
    {"gene": "EGFR", "log2FC": 2.93, "p_value": 0.0005, "subtype": "basal"},
    {"gene": "KRT5", "log2FC": 3.45, "p_value": 0.0002, "subtype": "basal"},
    {"gene": "FOXA1", "log2FC": 2.10, "p_value": 0.001, "subtype": "luminal"},
    {"gene": "GATA3", "log2FC": 1.95, "p_value": 0.002, "subtype": "luminal"},
    {"gene": "CCND1", "log2FC": 1.50, "p_value": 0.005, "subtype": "luminal"},
]


# ---------------------------------------------------------------------------
# Mock pipeline
# ---------------------------------------------------------------------------


def _run_mock_pipeline(ctx: RunContext, tracker: MetricsTracker) -> OutputBundle:
    """Execute the full pipeline with mock data — no network needed."""
    bundle = OutputBundle()

    # ---- Stage 1: search_pubmed --------------------------------------------
    with tracker.stage("search_pubmed"):
        logger.info("[mock] Searching PubMed for %r …", TOPIC)
        time.sleep(0.3)  # simulate network delay
        tracker.record_skill("pubmed")
        tracker.record_source(count=1)
        tracker.record_download("pubmed", file_count=0)
        tracker.record_processing(row_count=len(MOCK_PUBMED_RECORDS))

        for paper in MOCK_PUBMED_RECORDS:
            bundle.records.append(DataRecord(
                source="pubmed",
                accession=paper["pmid"],
                source_url=f"https://pubmed.ncbi.nlm.nih.gov/{paper['pmid']}/",
                raw_file="",
                doi=paper.get("doi"),
                pmid=paper.get("pmid"),
                pmcid=paper.get("pmcid"),
                fields={
                    "title": paper["title"],
                    "journal": paper["journal"],
                    "pub_date": paper["pub_date"],
                    "abstract": paper["abstract"][:200] + "…",
                },
            ))
        bundle.sources.append(SourceRecord(
            source="pubmed",
            accession="query:breast+cancer+gene+expression",
            source_url="https://pubmed.ncbi.nlm.nih.gov/",
            local_files=[],
            format_hint="pubmed_json",
            retrieved_at=datetime.now(timezone.utc),
        ))

    # ---- Stage 2: analyze_papers -------------------------------------------
    with tracker.stage("analyze_papers"):
        logger.info("[mock] Analyzing %d papers …", len(MOCK_PUBMED_RECORDS))
        time.sleep(0.2)
        tracker.record_skill("understanding")
        tracker.record_processing(row_count=len(MOCK_PUBMED_RECORDS))

        bundle.add_processing_step(
            tool="analyze_papers",
            params={"paper_count": len(MOCK_PUBMED_RECORDS)},
            affected_count=len(MOCK_PUBMED_RECORDS),
            description="Extracted GEO dataset references from abstracts",
        )
        bundle.add_warning(
            "info",
            "2 papers referenced GEO datasets without explicit accession numbers",
            source="analyze_papers",
            context="Manual review recommended",
        )

    # ---- Stage 3: search_geo -----------------------------------------------
    with tracker.stage("search_geo"):
        logger.info("[mock] Searching GEO for %r …", TOPIC)
        time.sleep(0.3)
        tracker.record_skill("geo")
        tracker.record_source(count=1)
        tracker.record_processing(row_count=len(MOCK_GEO_RECORDS))

        for ds in MOCK_GEO_RECORDS:
            bundle.records.append(DataRecord(
                source="geo",
                accession=ds["accession"],
                source_url=f"https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc={ds['accession']}",
                raw_file="",
                fields={
                    "title": ds["title"],
                    "organism": ds["organism"],
                    "sample_count": ds["sample_count"],
                    "platform_count": ds["platform_count"],
                },
            ))
        bundle.sources.append(SourceRecord(
            source="geo",
            accession="query:breast+cancer+gene+expression",
            source_url="https://www.ncbi.nlm.nih.gov/geo/",
            local_files=[],
            format_hint="geo_search_json",
            retrieved_at=datetime.now(timezone.utc),
        ))

    # ---- Stage 4: download_geo ---------------------------------------------
    with tracker.stage("download_geo"):
        logger.info("[mock] Downloading GEO datasets …")
        time.sleep(0.4)
        tracker.record_skill("geo")
        tracker.record_download("geo", file_count=len(MOCK_GEO_RECORDS))

        for ds in MOCK_GEO_RECORDS:
            accession = ds["accession"]
            local_path = ctx.work_dir.raw / f"{accession}_series_matrix.txt"
            local_path.parent.mkdir(parents=True, exist_ok=True)
            local_path.write_text(
                f"# Mock GEO matrix: {accession}\n"
                f"ID_REF\tSample1\tSample2\n"
                f"ESR1\t10.5\t12.3\n"
                f"PGR\t8.2\t7.1\n"
                f"ERBB2\t5.0\t15.8\n",
                encoding="utf-8",
            )
            ctx.add_raw_asset(str(local_path))
            bundle.sources.append(SourceRecord(
                source="geo",
                accession=accession,
                source_url=f"https://ftp.ncbi.nlm.nih.gov/geo/series/{accession[:5].lower()}nnn/{accession}/matrix/{accession}_series_matrix.txt.gz",
                local_files=[str(local_path)],
                format_hint="geo_series_matrix",
                mime_type="text/plain",
                retrieved_at=datetime.now(timezone.utc),
            ))

    # ---- Stage 5: parse_files ----------------------------------------------
    with tracker.stage("parse_files"):
        logger.info("[mock] Parsing downloaded files …")
        time.sleep(0.2)
        tracker.record_skill("biomed_parser")
        tracker.record_processing(row_count=len(MOCK_EXPRESSION_DATA))

        for rec in MOCK_EXPRESSION_DATA:
            bundle.records.append(DataRecord(
                source="geo", accession="GSE200001",
                source_url="https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE200001",
                raw_file=str(ctx.work_dir.raw / "GSE200001_series_matrix.txt"),
                fields={
                    "gene": rec["gene"],
                    "log2FC": rec["log2FC"],
                    "p_value": rec["p_value"],
                    "subtype": rec["subtype"],
                },
            ))

        bundle.add_processing_step(
            tool="parse_csv",
            params={"file_type": "geo_series_matrix"},
            affected_count=len(MOCK_EXPRESSION_DATA),
            description="Parsed series matrix files into structured DataRecords",
        )

    # ---- Stage 6: run_statistics -------------------------------------------
    with tracker.stage("run_statistics"):
        logger.info("[mock] Computing summary statistics …")
        time.sleep(0.3)
        tracker.record_skill("analysis")
        tracker.record_processing(row_count=len(MOCK_EXPRESSION_DATA))

        bundle.add_processing_step(
            tool="run_statistics",
            params={"dataset": "merged", "metrics": ["mean_log2FC", "count_by_subtype"]},
            affected_count=len(MOCK_EXPRESSION_DATA),
            description="Computed differential expression summary statistics",
        )

        subtypes: dict[str, int] = {}
        for rec in MOCK_EXPRESSION_DATA:
            st = str(rec["subtype"])
            subtypes[st] = subtypes.get(st, 0) + 1

        bundle.add_warning(
            "info",
            f"Subtype distribution: {json.dumps(subtypes)}",
            source="run_statistics",
        )

    # ---- Field descriptions ------------------------------------------------
    bundle.field_descriptions = [
        FieldDescription(
            name="gene", dtype="string",
            description="HUGO gene symbol",
            source="GEO series matrix",
        ),
        FieldDescription(
            name="log2FC", dtype="float",
            description="Log2 fold change vs. control",
            unit="log2 ratio",
            source="GEO series matrix",
        ),
        FieldDescription(
            name="p_value", dtype="float",
            description="Adjusted p-value from differential expression test",
            source="GEO series matrix",
        ),
        FieldDescription(
            name="subtype", dtype="string",
            description="Breast cancer molecular subtype",
            source="inferred from sample metadata",
        ),
    ]

    return bundle


# ---------------------------------------------------------------------------
# Output export
# ---------------------------------------------------------------------------


def _export_outputs(bundle: OutputBundle, output_dir: Path) -> dict[str, Path]:
    """Export the OutputBundle CSVs to *output_dir*."""
    output_dir.mkdir(parents=True, exist_ok=True)
    paths = export_bundle(bundle, output_dir)
    logger.info("Exported %d files to %s", len(paths), output_dir)
    for name, p in paths.items():
        logger.info("  %-20s → %s", name, p)
    return paths


# ---------------------------------------------------------------------------
# Real agent pipeline (requires DASHSCOPE_API_KEY)
# ---------------------------------------------------------------------------


async def _run_agent_pipeline(
    ctx: RunContext,
    tracker: MetricsTracker,
) -> OutputBundle:
    """Run the real Agent loop with Live LLM + tools."""
    from agents import Runner

    agent = create_agent()

    bundle = OutputBundle()
    logger.info("Starting Agent loop for topic %r …", TOPIC)

    total_start = time.monotonic()

    with tracker.stage("agent_loop"):
        logger.info("Calling Runner.run_streamed …")
        result = Runner.run_streamed(
            agent,
            f"Research topic: {TOPIC}. Search PubMed, analyze papers, "
            f"find GEO datasets, download relevant data, parse files, "
            f"and produce the standard output bundle (CSV, field docs, "
            f"source manifest, processing log).",
            context=ctx,
        )

        async for event in result.stream_events():
            from agents.stream_events import RawResponsesStreamEvent, RunItemStreamEvent
            if isinstance(event, RawResponsesStreamEvent):
                choices = getattr(event.data, "choices", None)
                if choices:
                    delta = getattr(getattr(choices[0], "delta", None), "content", None)
                    if delta:
                        tracker.record_processing(row_count=0)
            elif isinstance(event, RunItemStreamEvent):
                if event.name == "tool_called":
                    raw = getattr(event.item, "raw_item", None)
                    tname = getattr(raw, "name", "?") if raw else "?"
                    logger.info("  → tool call: %s", tname)
                    tracker.record_skill(tname)
                elif event.name == "tool_output":
                    out = str(getattr(event.item, "output", ""))[:200]
                    logger.info("  ← tool output: %s", out)

        final = result.final_output or ""
        logger.info("Agent loop finished (%d chars of output)", len(final))

    total_end = time.monotonic()
    logger.info("Total wall-clock time: %.1f s", total_end - total_start)

    # Harvest records and sources from the RunContext
    for src in ctx.sources:
        if hasattr(src, "source"):
            bundle.sources.append(src)
    for rec in ctx.records:
        if isinstance(rec, dict):
            bundle.records.append(DataRecord(
                source=rec.get("source", "unknown"),
                accession=rec.get("accession", ""),
                source_url=rec.get("source_url", ""),
                raw_file=rec.get("raw_file", ""),
                fields={k: v for k, v in rec.items()
                        if k not in ("source", "accession", "source_url", "raw_file")},
            ))
    for warn in ctx.warnings:
        bundle.warnings.append(WarningEntry(
            severity=warn.get("severity", "warning"),
            message=warn.get("message", ""),
            source=warn.get("source"),
        ))

    tracker.record_download("pipeline", file_count=len(ctx.raw_assets))
    tracker.record_processing(row_count=len(bundle.records))

    return bundle


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------


def _print_summary(
    bundle: OutputBundle,
    tracker: MetricsTracker,
    mode: str,
) -> None:
    """Print a human-readable pipeline summary."""
    summary = tracker.to_json()
    print()
    print("=" * 60)
    print("  BioMed-QAgent Demo Pipeline — Summary")
    print("=" * 60)
    print(f"  Mode:             {mode}")
    print(f"  Topic:            {TOPIC}")
    print(f"  Task ID:          {TASK_ID}")
    print(f"  Output directory: {OUTPUT_DIR}")
    print("-" * 60)
    print(f"  Sources found:      {summary['total_sources_count']}")
    print(f"  Files downloaded:   {summary['total_files_downloaded']}")
    print(f"  Rows processed:     {summary['total_rows_processed']}")
    print(f"  Warnings:           {len(summary['total_warnings'])}")
    print(f"  Errors:             {len(summary['total_errors'])}")
    print(f"  Skills used:        {', '.join(summary['skill_names_used']) or '(none)'}")
    print("-" * 60)
    print(f"  Main data rows:     {len(bundle.records)}")
    print(f"  Source records:     {len(bundle.sources)}")
    print(f"  Processing steps:   {len(bundle.processing_steps)}")
    print("=" * 60)

    # Print stage timings
    stages = summary.get("stages", {})
    if stages:
        print()
        print("  Stage timings:")
        for name, s in stages.items():
            t = s.get("execution_time_sec", 0)
            print(f"    {name:<20s} {t:.2f}s")


def _main() -> int:
    """Run the demo pipeline and export all outputs."""
    logger.info("BioMed-QAgent Demo Pipeline starting …")
    logger.info("Topic: %s", TOPIC)
    logger.info("Output: %s", OUTPUT_DIR)

    ctx = RunContext(task_id=TASK_ID, topic=TOPIC)
    tracker = MetricsTracker(task_id=TASK_ID)

    # Decide execution mode
    api_key = os.getenv("DASHSCOPE_API_KEY", "")
    use_agent = bool(api_key)

    if not use_agent:
        logger.info(
            "DASHSCOPE_API_KEY not set — using mock pipeline (no network needed)"
        )
        bundle = _run_mock_pipeline(ctx, tracker)
        mode = "mock"
    else:
        logger.info("DASHSCOPE_API_KEY found — using real Agent Runner")
        try:
            bundle = asyncio.run(_run_agent_pipeline(ctx, tracker))
            mode = "real"
        except Exception as exc:
            logger.warning(
                "Agent pipeline failed (%s), falling back to mock mode", exc
            )
            # Reset context for clean mock run
            ctx = RunContext(task_id=TASK_ID, topic=TOPIC)
            tracker = MetricsTracker(task_id=TASK_ID)
            bundle = _run_mock_pipeline(ctx, tracker)
            tracker.add_warning(f"Agent fallback: {exc}")
            mode = "mock (agent fallback)"

    # Export CSVs
    _export_outputs(bundle, OUTPUT_DIR)

    # Export metrics
    metrics_path = OUTPUT_DIR / "metrics.json"
    tracker.save(metrics_path)
    logger.info("Metrics saved to %s", metrics_path)

    # Print summary
    _print_summary(bundle, tracker, mode)

    return 0


if __name__ == "__main__":
    sys.exit(_main())
