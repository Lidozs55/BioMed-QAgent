"""Phase 5 T6: evidence-backed bidirectional GEO source relations."""

from __future__ import annotations

from datetime import UTC, datetime

from app.datasets.build.geo_relations import build_geo_source_relations
from app.domain.contracts import Database, GeoSeriesRecord, SourceRecord


def _geo() -> GeoSeriesRecord:
    return GeoSeriesRecord(
        uid="200178352",
        accession="GSE178352",
        pubmed_ids=["34180400", "12345678", "34180400"],
        sample_count=0,
    )


def test_each_evidenced_pmid_emits_two_sorted_inverse_rows() -> None:
    pubmed = SourceRecord(
        source_id="src_pubmed_34180400",
        database=Database.PUBMED,
        accession="34180400",
        url="https://pubmed.ncbi.nlm.nih.gov/34180400/",
        title="Primary article",
        retrieved_at=datetime.now(UTC),
    )

    relations = build_geo_source_relations(
        geo_source_id="src_geo_gse178352",
        geo=_geo(),
        sources=[pubmed],
    )

    assert len(relations) == 4
    assert {relation.relation_type for relation in relations} == {
        "article_describes_dataset",
        "dataset_described_by_article",
        "geo_references_pubmed",
        "pubmed_referenced_by_geo",
    }
    acquired = [
        relation
        for relation in relations
        if relation.evidence_value == "34180400"
    ]
    assert {relation.from_source_id for relation in acquired} == {
        "src_geo_gse178352",
        "src_pubmed_34180400",
    }
    external = [
        relation
        for relation in relations
        if relation.evidence_value == "12345678"
    ]
    assert {relation.from_source_id for relation in external} == {
        "src_geo_gse178352",
        "ext:pubmed:12345678",
    }
    keys = [
        (
            relation.from_source_id,
            relation.to_source_id,
            relation.relation_type,
            relation.evidence_type,
            relation.evidence_value,
        )
        for relation in relations
    ]
    assert keys == sorted(keys)


def test_no_geo_metadata_evidence_emits_no_relation() -> None:
    geo = _geo().model_copy(update={"pubmed_ids": []})
    assert build_geo_source_relations(
        geo_source_id="src_geo_gse178352",
        geo=geo,
        sources=[],
    ) == []
