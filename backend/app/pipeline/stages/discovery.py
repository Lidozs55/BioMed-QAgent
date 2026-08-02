"""Discovery stage: parse fixture or live NCBI data into SourceRecords."""

from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import UTC, datetime

from app.domain.contracts import (
    Database,
    DatasetSelection,
    QuerySpecification,
    RequestedOutput,
    SourceRecord,
    StageName,
    TaskSpecification,
    make_dataset_id,
    make_source_id,
)
from app.domain.contracts.discovery import GeoSeriesRecord, LiteratureRecord
from app.integrations.ncbi.parsers import parse_geo_esummary, parse_pubmed_xml
from app.pipeline.stages.base import DiscoveryOutput, StageContext, StageResult

_DEFAULT_PMID = "34180400"
_DEFAULT_GSE = "GSE178352"

logger = logging.getLogger(__name__)


def _extract_pmid(query: str) -> str | None:
    match = re.search(r"(\d+)(?:\[PMID\])?", query)
    return match.group(1) if match else None


def _extract_gse_accession(query: str) -> str | None:
    match = re.search(r"(GSE\d+)(?:\[Accession\])?", query, re.IGNORECASE)
    return match.group(1).upper() if match else None


async def _search_pubmed_with_fallback(
    client,
    topic: str,
    max_results: int = 5,
) -> LiteratureRecord:
    """Search PubMed with fallback to a simplified query on empty results."""
    from app.integrations.ncbi.discovery import search_pubmed
    from app.integrations.ncbi.query_utils import simplify_ncbi_query

    result = await search_pubmed(client, query=topic, max_results=max_results)
    if result.records:
        return result.records[0]

    simplified = simplify_ncbi_query(topic)
    if simplified != topic:
        logger.info("PubMed: raw topic yielded 0 results, retrying with %r", simplified)
        result = await search_pubmed(client, query=simplified, max_results=max_results)
        if result.records:
            return result.records[0]

    raise LookupError(f"PubMed search returned no records for topic: {topic}")


async def _search_geo_with_fallback(
    client,
    topic: str,
    max_results: int = 20,
) -> GeoSeriesRecord:
    """Search GEO with fallback to simplified / gene-only queries."""
    from app.integrations.ncbi.discovery import search_geo_series
    from app.integrations.ncbi.query_utils import simplify_ncbi_query

    result = await search_geo_series(client, query=topic, max_results=max_results)
    gse_records = [r for r in result.records if r.accession.startswith("GSE")]
    if gse_records:
        return gse_records[0]

    simplified = simplify_ncbi_query(topic)
    if simplified != topic:
        logger.info("GEO: raw topic yielded 0 GSE results, retrying with %r", simplified)
        result = await search_geo_series(client, query=simplified, max_results=max_results)
        gse_records = [r for r in result.records if r.accession.startswith("GSE")]
        if gse_records:
            return gse_records[0]

    # Last resort: gene-only search
    gene_matches = re.findall(r"\b([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*\d+)\b", topic)
    if gene_matches and gene_matches[0] != simplified:
        logger.info(
            "GEO: simplified query yielded 0 results, retrying gene-only %r",
            gene_matches[0],
        )
        result = await search_geo_series(client, query=gene_matches[0], max_results=max_results)
        gse_records = [r for r in result.records if r.accession.startswith("GSE")]
        if gse_records:
            return gse_records[0]

    raise LookupError(f"GEO search returned no GSE series for topic: {topic}")


def run_discovery(ctx: StageContext) -> StageResult:
    """Parse fixture or live NCBI data into SourceRecords and TaskSpecification.

    In fixture mode, reads pre-downloaded XML/JSON from ``ctx.fixture_dir``.
    In live mode, calls NCBI E-utilities to fetch real-time metadata for the
    PubMed/GEO queries defined in ``ctx.specification``. When no specific
    PMID/GSE is provided, searches NCBI by topic to find relevant records.
    """
    specification = ctx.specification
    if specification is None:
        specification = _build_default_specification(ctx)
        logger.info(
            "discovery: no agent specification, built default (mode=%s, topic=%r)",
            ctx.mode,
            ctx.topic[:80],
        )
    else:
        logger.info(
            "discovery: using agent specification (%d queries, %d datasets)",
            len(specification.queries),
            len(specification.datasets),
        )

    selected_databases = {
        query.database for query in specification.queries
    } | {dataset.database for dataset in specification.datasets}
    if Database.REACTOME in selected_databases and selected_databases != {Database.REACTOME}:
        raise ValueError("Reactome cannot be combined with other data sources")
    reactome_datasets = [
        dataset for dataset in specification.datasets if dataset.database == Database.REACTOME
    ]
    if len(reactome_datasets) > 1:
        raise ValueError("Reactome supports exactly one explicit DatasetSelection")

    gdc_dataset = next(
        (dataset for dataset in specification.datasets if dataset.database == Database.GDC),
        None,
    )
    if gdc_dataset is not None:
        return _run_gdc_discovery(ctx, specification, gdc_dataset)
    xena_dataset = next(
        (dataset for dataset in specification.datasets if dataset.database == Database.UCSC_XENA),
        None,
    )
    if xena_dataset is not None:
        return _run_xena_discovery(ctx, specification, xena_dataset)
    reactome_dataset = next(
        (dataset for dataset in specification.datasets if dataset.database == Database.REACTOME),
        None,
    )
    if reactome_dataset is not None:
        return _run_reactome_discovery(ctx, specification, reactome_dataset)

    pmid = _resolve_pmid(specification)
    gse = _resolve_gse(specification)
    logger.info(
        "discovery: resolved pmid=%s gse=%s (mode=%s, topic=%r)",
        pmid,
        gse,
        ctx.mode,
        ctx.topic[:80],
    )

    if ctx.mode == "live":
        # Issue #2: the pipeline must not auto-search GEO by topic when no
        # explicit gse was provided.  Auto-discovered datasets are unvetted
        # by the Agent and frequently fail at the acquisition stage (e.g.
        # "family SOFT required when tximport counts are available").  The
        # Agent is responsible for discovering and vetting accessions before
        # calling run_research_pipeline.
        if gse is None:
            raise LookupError(
                "No explicit GEO accession (gse) was provided. The pipeline "
                "does not auto-search GEO by topic. Use search_geo to discover "
                "a relevant GSE accession and pass it via the gse parameter "
                "to run_research_pipeline."
            )
        literature, geo, retrieved_at = _run_discovery_live(pmid, gse, topic=ctx.topic)
    else:
        literature, geo, retrieved_at = _run_discovery_fixture(
            ctx.fixture_dir, pmid or _DEFAULT_PMID, gse or _DEFAULT_GSE
        )
    logger.info(
        "discovery: success pmid=%s gse=%s title=%r",
        literature.pmid,
        geo.accession,
        literature.title[:80],
    )

    # Surface discovery progress: "Discovery: found 1 PubMed record + 1 GEO series".
    # See docs/REVIEW_2026-07-18.md §4.
    ctx.emit_progress_sync(
        stage=StageName.DISCOVERY,
        kind="discovered_records",
        current=2,
        total=2,
        detail={
            "source": "ncbi",
            "pmid": literature.pmid,
            "gse": geo.accession,
        },
    )

    return _build_output(ctx, literature, geo, specification, retrieved_at)


def _build_default_specification(ctx: StageContext) -> TaskSpecification:
    """Return a topic-derived specification when none was supplied.

    For live mode, queries are topic-based (no hardcoded PMID/GSE); the
    discovery stage searches NCBI by topic. For fixture mode, the pinned
    Phase 1 case (GSE178352 + PMID 34180400) is used to preserve backward
    compatibility with offline regression tests.

    Issue #2: in live mode, the GEO topic query is only added when GEO is
    in ``ctx.databases``.  Even so, the discovery stage requires an explicit
    ``gse`` accession — the topic query alone will not trigger a GEO search.
    """
    if ctx.mode == "live":
        selected = {db.lower() for db in ctx.databases}
        queries: list[QuerySpecification] = [
            QuerySpecification(
                query_id="query_pubmed_1",
                database=Database.PUBMED,
                query=ctx.topic,
                generated_by="pipeline",
                purpose="find literature by topic",
                order=1,
            ),
        ]
        if "geo" in selected:
            queries.append(
                QuerySpecification(
                    query_id="query_geo_1",
                    database=Database.GEO,
                    query=ctx.topic,
                    generated_by="pipeline",
                    purpose="find expression dataset by topic",
                    order=2,
                ),
            )
        return TaskSpecification(
            topic=ctx.topic,
            queries=queries,
            datasets=[],
            requested_outputs=[
                RequestedOutput.MAIN_DATA,
                RequestedOutput.LITERATURE,
                RequestedOutput.DATASET_CATALOG,
                RequestedOutput.SAMPLE_METADATA,
            ],
        )
    return TaskSpecification(
        topic=ctx.topic,
        queries=[
            QuerySpecification(
                query_id="query_geo_1",
                database=Database.GEO,
                query=f"{_DEFAULT_GSE}[Accession]",
                generated_by="pipeline",
                purpose="pinned dataset",
                order=1,
            ),
            QuerySpecification(
                query_id="query_pubmed_1",
                database=Database.PUBMED,
                query=f"{_DEFAULT_PMID}[PMID]",
                generated_by="pipeline",
                purpose="pinned literature",
                order=2,
            ),
        ],
        datasets=[
            DatasetSelection(
                dataset_id=f"ds_geo_{_DEFAULT_GSE.lower()}",
                database=Database.GEO,
                accession=_DEFAULT_GSE,
                source_id="",
                reason=f"linked from PMID {_DEFAULT_PMID}",
            )
        ],
        requested_outputs=[
            RequestedOutput.MAIN_DATA,
            RequestedOutput.LITERATURE,
            RequestedOutput.DATASET_CATALOG,
            RequestedOutput.SAMPLE_METADATA,
        ],
    )


def _resolve_pmid(specification: TaskSpecification) -> str | None:
    """Return an explicit PMID from the specification, or None to search by topic."""
    for query in specification.queries:
        if query.database == Database.PUBMED:
            pmid = _extract_pmid(query.query)
            if pmid:
                return pmid
    return None


def _resolve_gse(specification: TaskSpecification) -> str | None:
    """Return an explicit GSE accession from the specification, or None to search by topic."""
    for query in specification.queries:
        if query.database == Database.GEO:
            gse = _extract_gse_accession(query.query)
            if gse:
                return gse
    for dataset in specification.datasets:
        if dataset.database == Database.GEO:
            gse = _extract_gse_accession(dataset.accession)
            if gse:
                return gse
    return None


def _run_discovery_fixture(
    fixture_dir,
    pmid: str,
    gse: str,
) -> tuple[LiteratureRecord, GeoSeriesRecord, datetime]:
    fixture_manifest = json.loads((fixture_dir / "manifest.json").read_text("utf-8"))
    retrieved_at: datetime = datetime.fromisoformat(fixture_manifest["retrieved_at"])
    literature: LiteratureRecord = parse_pubmed_xml(
        (fixture_dir / f"pubmed_{pmid}.xml").read_bytes()
    )[0]
    geo: GeoSeriesRecord = parse_geo_esummary((fixture_dir / "geo_esummary.json").read_bytes())[0]
    return literature, geo, retrieved_at


def _run_discovery_live(
    pmid: str | None,
    gse: str | None,
    *,
    topic: str,
) -> tuple[LiteratureRecord, GeoSeriesRecord, datetime]:
    """Fetch real PubMed and GEO metadata via NCBI E-utilities.

    When ``pmid``/``gse`` is None, searches NCBI by ``topic`` and uses the
    first result.  Natural-language topics (e.g. "METTL5 expression in
    pancreatic cancer") are automatically simplified into structured queries
    (e.g. "METTL5 AND pancreatic cancer") when the raw topic returns no
    records — this avoids the NCBI MeSH expansion producing overly specific
    queries with zero matches.
    """
    from app.integrations.ncbi.factory import open_ncbi_services

    retrieved_at = datetime.now(UTC)

    async def _fetch() -> tuple[LiteratureRecord, GeoSeriesRecord]:
        async with open_ncbi_services() as svc:
            if pmid is not None:
                pubmed_xml = await svc.eutils.efetch(db="pubmed", ids=[pmid], retmode="xml")
                pubmed_records = parse_pubmed_xml(pubmed_xml)
                if not pubmed_records:
                    raise LookupError(f"PubMed article not found: PMID {pmid}")
                literature = pubmed_records[0]
            else:
                # Search PubMed by topic, with fallback to simplified query.
                literature = await _search_pubmed_with_fallback(svc.eutils, topic)

            if gse is not None:
                # Fetch GEO series metadata by accession
                geo_payload = await svc.eutils.esearch(
                    db="gds", term=f"{gse}[Accession]", retmax=100
                )
                from app.integrations.ncbi.parsers import parse_ncbi_esearch

                page = parse_ncbi_esearch(geo_payload)
                if not page.ids:
                    raise LookupError(f"GEO series not found: {gse}")
                geo_summary = await svc.eutils.esummary(db="gds", ids=page.ids[:1])
                geo_records = parse_geo_esummary(geo_summary)
                geo = next(
                    (r for r in geo_records if r.accession == gse),
                    geo_records[0] if geo_records else None,
                )
                if geo is None:
                    raise LookupError(f"GEO series not found: {gse}")
            else:
                # Search GEO by topic, with fallback to simplified query.
                geo = await _search_geo_with_fallback(svc.eutils, topic)
            return literature, geo

    literature, geo = asyncio.run(_fetch())
    return literature, geo, retrieved_at


def _run_gdc_discovery(
    ctx: StageContext,
    specification: TaskSpecification,
    dataset: DatasetSelection,
) -> StageResult:
    if not dataset.accession or not dataset.data_type:
        raise ValueError("GDC discovery requires project_id and data_type")
    retrieved_at = datetime.now(UTC)
    url = f"https://api.gdc.cancer.gov/projects/{dataset.accession}"
    source_id = make_source_id(Database.GDC, dataset.accession, url)
    resolved = dataset.model_copy(update={"source_id": source_id})
    output = DiscoveryOutput(
        sources=[
            SourceRecord(
                source_id=source_id,
                database=Database.GDC,
                accession=dataset.accession,
                url=url,
                title=f"GDC {dataset.accession}",
                retrieved_at=retrieved_at,
            )
        ],
        literature=None,
        geo=None,
        specification=specification.model_copy(update={"datasets": [resolved]}),
        dataset_source_id=source_id,
        dataset_accession=dataset.accession,
        dataset_title=f"GDC {dataset.accession}",
        dataset_url=url,
        dataset_id=resolved.dataset_id,
        retrieved_at=retrieved_at,
    )
    return StageResult(output_digest=_digest_discovery(output), output=output)


def _run_xena_discovery(
    ctx: StageContext,
    specification: TaskSpecification,
    dataset: DatasetSelection,
) -> StageResult:
    retrieved_at = (
        datetime.fromtimestamp((ctx.fixture_dir / "xena_matrix.tsv").stat().st_mtime, UTC)
        if ctx.mode != "live"
        else datetime.now(UTC)
    )
    if ctx.mode == "live" and not dataset.accession:
        raise ValueError("live Xena discovery requires an explicit dataset accession")
    url = f"https://xenabrowser.net/datapages/?dataset={dataset.accession}"
    source_id = make_source_id(Database.UCSC_XENA, dataset.accession, url)
    resolved = dataset.model_copy(update={"source_id": source_id})
    output_specification = specification.model_copy(update={"datasets": [resolved]})
    source = SourceRecord(
        source_id=source_id,
        database=Database.UCSC_XENA,
        accession=dataset.accession,
        url=url,
        title=dataset.accession,
        retrieved_at=retrieved_at,
    )
    output = DiscoveryOutput(
        sources=[source],
        literature=None,
        geo=None,
        specification=output_specification,
        dataset_source_id=source_id,
        dataset_accession=dataset.accession,
        dataset_title=dataset.accession,
        dataset_url=url,
        dataset_id=resolved.dataset_id,
        retrieved_at=retrieved_at,
    )
    ctx.emit_progress_sync(
        stage=StageName.DISCOVERY,
        kind="discovered_records",
        current=1,
        total=1,
        detail={"source": "ucsc_xena", "accession": dataset.accession},
    )
    return StageResult(output_digest=_digest_discovery(output), output=output)


def _run_reactome_discovery(
    ctx: StageContext,
    specification: TaskSpecification,
    dataset: DatasetSelection,
) -> StageResult:
    if not dataset.accession or dataset.data_type != "pathway-participants":
        raise ValueError(
            "Reactome discovery requires pathway_id and pathway-participants data_type"
        )
    retrieved_at = datetime.now(UTC)
    url = f"https://reactome.org/ContentService/data/participants/{dataset.accession}"
    source_id = make_source_id(Database.REACTOME, dataset.accession, url)
    resolved = dataset.model_copy(update={"source_id": source_id})
    output = DiscoveryOutput(
        sources=[
            SourceRecord(
                source_id=source_id,
                database=Database.REACTOME,
                accession=dataset.accession,
                url=url,
                title=f"Reactome {dataset.accession} participants",
                retrieved_at=retrieved_at,
            )
        ],
        literature=None,
        geo=None,
        specification=specification.model_copy(update={"datasets": [resolved]}),
        dataset_source_id=source_id,
        dataset_accession=dataset.accession,
        dataset_title=f"Reactome {dataset.accession} participants",
        dataset_url=url,
        dataset_id=resolved.dataset_id,
        retrieved_at=retrieved_at,
    )
    ctx.emit_progress_sync(
        stage=StageName.DISCOVERY,
        kind="discovered_records",
        current=1,
        total=1,
        detail={"source": "reactome", "accession": dataset.accession},
    )
    return StageResult(output_digest=_digest_discovery(output), output=output)


def _build_output(
    ctx: StageContext,
    literature: LiteratureRecord,
    geo: GeoSeriesRecord,
    specification: TaskSpecification,
    retrieved_at: datetime,
) -> StageResult:
    pubmed_url = literature.source_url
    geo_url = f"https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc={geo.accession}"
    pubmed_source_id = make_source_id(Database.PUBMED, literature.pmid, pubmed_url)
    geo_source_id = make_source_id(Database.GEO, geo.accession, geo_url)
    dataset_id = make_dataset_id(Database.GEO, geo.accession)

    sources = [
        SourceRecord(
            source_id=pubmed_source_id,
            database=Database.PUBMED,
            accession=literature.pmid,
            url=pubmed_url,
            title=literature.title,
            retrieved_at=retrieved_at,
        ),
        SourceRecord(
            source_id=geo_source_id,
            database=Database.GEO,
            accession=geo.accession,
            url=geo_url,
            title=geo.title,
            retrieved_at=retrieved_at,
        ),
    ]

    # Use the passed specification but ensure IDs match the resolved records.
    resolved_datasets = [
        DatasetSelection(
            dataset_id=dataset_id,
            database=Database.GEO,
            accession=geo.accession,
            source_id=geo_source_id,
            reason=f"linked from PMID {literature.pmid}",
        )
    ]
    output_specification = specification.model_copy(update={"datasets": resolved_datasets})

    output = DiscoveryOutput(
        sources=sources,
        literature=literature,
        geo=geo,
        specification=output_specification,
        pubmed_source_id=pubmed_source_id,
        geo_source_id=geo_source_id,
        dataset_source_id=geo_source_id,
        dataset_accession=geo.accession,
        dataset_title=geo.title,
        dataset_url=geo_url,
        dataset_id=dataset_id,
        retrieved_at=retrieved_at,
    )
    return StageResult(output_digest=_digest_discovery(output), output=output)


def _digest_discovery(output: DiscoveryOutput) -> str:
    """Compute a stable sha256 digest for DiscoveryOutput."""
    import hashlib

    payload = {
        "pubmed_source_id": output.pubmed_source_id,
        "geo_source_id": output.geo_source_id,
        "dataset_id": output.dataset_id,
        "literature_pmid": output.literature.pmid if output.literature else None,
        "geo_accession": output.geo.accession if output.geo else None,
        "dataset_source_id": output.dataset_source_id,
        "dataset_accession": output.dataset_accession,
        "topic": output.specification.topic,
        # 规范化多源查询/数据集选择（§1.5.1）：查询变化必须改变 discovery
        # digest，避免 checkpoint 复用把新查询误判为与旧结果一致。
        "queries": [
            {"database": query.database.value, "query": query.query}
            for query in sorted(
                output.specification.queries, key=lambda q: q.order
            )
        ],
        "datasets": [
            {
                "database": dataset.database.value,
                "accession": dataset.accession,
                "data_type": dataset.data_type,
            }
            for dataset in output.specification.datasets
        ],
    }
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()
