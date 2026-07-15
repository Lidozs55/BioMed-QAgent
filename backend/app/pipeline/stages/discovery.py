"""Discovery stage: parse fixture PubMed XML and GEO esummary into SourceRecords."""
from __future__ import annotations

import json
from datetime import datetime

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


def run_discovery(ctx: StageContext) -> StageResult:
    """Parse fixture files into SourceRecords and TaskSpecification.

    Reads ``manifest.json``, ``pubmed_34180400.xml`` and ``geo_esummary.json``
    from the fixture directory and builds the canonical source IDs and
    specification used by downstream stages.
    """
    fixture_manifest = json.loads((ctx.fixture_dir / "manifest.json").read_text("utf-8"))
    retrieved_at: datetime = datetime.fromisoformat(fixture_manifest["retrieved_at"])
    literature: LiteratureRecord = parse_pubmed_xml(
        (ctx.fixture_dir / "pubmed_34180400.xml").read_bytes()
    )[0]
    geo: GeoSeriesRecord = parse_geo_esummary(
        (ctx.fixture_dir / "geo_esummary.json").read_bytes()
    )[0]

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
                query="GSE178352[Accession]",
                generated_by="pipeline",
                purpose="pinned dataset",
                order=1,
            ),
            QuerySpecification(
                query_id="query_pubmed_1",
                database=Database.PUBMED,
                query="34180400[PMID]",
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
                reason="linked from PMID 34180400",
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
