"""Discovery stage: parse fixture or live PubMed/GEO into SourceRecords."""
from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime

from app.domain.contracts import (
    Database,
    DatasetSelection,
    QuerySpecification,
    RequestedOutput,
    SourceRecord,
    TaskSpecification,
    make_dataset_id,
    make_source_id,
)
from app.domain.contracts.discovery import GeoSeriesRecord, LiteratureRecord
from app.integrations.ncbi.parsers import parse_geo_esummary, parse_pubmed_xml
from app.pipeline.stages.base import DiscoveryOutput, StageContext, StageResult

_PMID = "34180400"
_GSE = "GSE178352"


def run_discovery(ctx: StageContext) -> StageResult:
    """Parse fixture or live NCBI data into SourceRecords and TaskSpecification.

    In fixture mode, reads pre-downloaded XML/JSON from ``ctx.fixture_dir``.
    In live mode, calls NCBI E-utilities to fetch real-time metadata for
    the pinned PMID 34180400 and GSE178352.
    """
    if ctx.mode == "live":
        literature, geo, retrieved_at = _run_discovery_live()
    else:
        literature, geo, retrieved_at = _run_discovery_fixture(ctx.fixture_dir)

    return _build_output(ctx, literature, geo, retrieved_at)


def _run_discovery_fixture(
    fixture_dir,
) -> tuple[LiteratureRecord, GeoSeriesRecord, datetime]:
    fixture_manifest = json.loads((fixture_dir / "manifest.json").read_text("utf-8"))
    retrieved_at: datetime = datetime.fromisoformat(fixture_manifest["retrieved_at"])
    literature: LiteratureRecord = parse_pubmed_xml(
        (fixture_dir / "pubmed_34180400.xml").read_bytes()
    )[0]
    geo: GeoSeriesRecord = parse_geo_esummary(
        (fixture_dir / "geo_esummary.json").read_bytes()
    )[0]
    return literature, geo, retrieved_at


def _run_discovery_live() -> tuple[LiteratureRecord, GeoSeriesRecord, datetime]:
    """Fetch real PubMed and GEO metadata via NCBI E-utilities."""
    from app.integrations.ncbi.factory import open_ncbi_services

    retrieved_at = datetime.now(UTC)

    async def _fetch() -> tuple[LiteratureRecord, GeoSeriesRecord]:
        async with open_ncbi_services() as svc:
            # Fetch PubMed article by PMID
            pubmed_xml = await svc.eutils.efetch(
                db="pubmed", ids=[_PMID], retmode="xml"
            )
            pubmed_records = parse_pubmed_xml(pubmed_xml)
            if not pubmed_records:
                raise LookupError(f"PubMed article not found: PMID {_PMID}")
            literature = pubmed_records[0]

            # Fetch GEO series metadata by accession
            geo_payload = await svc.eutils.esearch(
                db="gds", term=f"{_GSE}[Accession]", retmax=100
            )
            from app.integrations.ncbi.parsers import parse_ncbi_esearch

            page = parse_ncbi_esearch(geo_payload)
            if not page.ids:
                raise LookupError(f"GEO series not found: {_GSE}")
            geo_summary = await svc.eutils.esummary(db="gds", ids=page.ids[:1])
            geo_records = parse_geo_esummary(geo_summary)
            geo = next(
                (r for r in geo_records if r.accession == _GSE),
                geo_records[0] if geo_records else None,
            )
            if geo is None:
                raise LookupError(f"GEO series not found: {_GSE}")
            return literature, geo

    literature, geo = asyncio.run(_fetch())
    return literature, geo, retrieved_at


def _build_output(
    ctx: StageContext,
    literature: LiteratureRecord,
    geo: GeoSeriesRecord,
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

    specification = TaskSpecification(
        topic=ctx.topic,
        queries=[
            QuerySpecification(
                query_id="query_geo_1",
                database=Database.GEO,
                query=f"{_GSE}[Accession]",
                generated_by="pipeline",
                purpose="pinned dataset",
                order=1,
            ),
            QuerySpecification(
                query_id="query_pubmed_1",
                database=Database.PUBMED,
                query=f"{_PMID}[PMID]",
                generated_by="pipeline",
                purpose="pinned literature",
                order=2,
            ),
        ],
        datasets=[
            DatasetSelection(
                dataset_id=dataset_id,
                database=Database.GEO,
                accession=geo.accession,
                source_id=geo_source_id,
                reason=f"linked from PMID {_PMID}",
            )
        ],
        requested_outputs=[
            RequestedOutput.MAIN_DATA,
            RequestedOutput.LITERATURE,
            RequestedOutput.DATASET_CATALOG,
            RequestedOutput.SAMPLE_METADATA,
        ],
    )

    output = DiscoveryOutput(
        sources=sources,
        literature=literature,
        geo=geo,
        specification=specification,
        pubmed_source_id=pubmed_source_id,
        geo_source_id=geo_source_id,
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
        "literature_pmid": output.literature.pmid,
        "geo_accession": output.geo.accession,
        "topic": output.specification.topic,
    }
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()
