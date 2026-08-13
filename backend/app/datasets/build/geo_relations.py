"""Evidence-backed, bidirectional GEO source relation generation."""

from __future__ import annotations

import csv
from pathlib import Path

from app.domain.contracts import (
    Database,
    GeoSeriesRecord,
    SourceRecord,
    SourceRelation,
)

SOURCE_RELATION_COLUMNS = (
    "relation_id",
    "from_source_id",
    "to_source_id",
    "relation_type",
    "evidence_type",
    "evidence_value",
    "evidence_url",
)


def build_geo_source_relations(
    *,
    geo_source_id: str,
    geo: GeoSeriesRecord,
    sources: list[SourceRecord],
) -> list[SourceRelation]:
    acquired_pubmed = {
        source.accession: source.source_id
        for source in sources
        if source.database is Database.PUBMED
    }
    evidence_url = (
        "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=" + geo.accession
    )
    rows: list[SourceRelation] = []
    for pmid in dict.fromkeys(geo.pubmed_ids):
        pubmed_source_id = acquired_pubmed.get(pmid)
        if pubmed_source_id is None:
            pubmed_source_id = f"ext:pubmed:{pmid}"
            forward_type = "geo_references_pubmed"
            inverse_type = "pubmed_referenced_by_geo"
        else:
            forward_type = "dataset_described_by_article"
            inverse_type = "article_describes_dataset"
        rows.extend(
            [
                SourceRelation(
                    relation_id=f"rel_{geo.accession.lower()}_pmid{pmid}",
                    from_source_id=geo_source_id,
                    to_source_id=pubmed_source_id,
                    relation_type=forward_type,
                    evidence_type="geo_pubmed_id",
                    evidence_value=pmid,
                    evidence_url=evidence_url,
                ),
                SourceRelation(
                    relation_id=f"rel_pmid{pmid}_{geo.accession.lower()}",
                    from_source_id=pubmed_source_id,
                    to_source_id=geo_source_id,
                    relation_type=inverse_type,
                    evidence_type="geo_pubmed_id",
                    evidence_value=pmid,
                    evidence_url=evidence_url,
                ),
            ]
        )
    return sorted(
        rows,
        key=lambda row: (
            row.from_source_id,
            row.to_source_id,
            row.relation_type,
            row.evidence_type,
            row.evidence_value,
        ),
    )


def write_source_relations(path: Path, relations: list[SourceRelation]) -> Path:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=SOURCE_RELATION_COLUMNS)
        writer.writeheader()
        for relation in relations:
            writer.writerow(
                relation.model_dump(mode="json", exclude={"schema_version"})
            )
    return path
