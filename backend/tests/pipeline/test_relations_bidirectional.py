"""Phase 5 T6 D3 red tests: bidirectional source relations (shared generator).

D3 requires the shared relation generator (used by V1 ``source_relations.csv``
AND the V2 relation audit) to emit EXPLICIT INVERSE rows:

* every evidenced GSE×PMID pair yields exactly two rows —
  ``article_describes_dataset`` + ``dataset_described_by_article`` for the
  acquired PMID, and ``geo_references_pubmed`` + ``pubmed_referenced_by_geo``
  for external PMIDs (``ext:pubmed:<pmid>``);
* GSE/GSE edges only with explicit evidence (``related_series``, both
  directions); a shared request is NOT evidence;
* dedup key ``(from_source_id, to_source_id, relation_type, evidence_type,
  evidence_value)`` with stable ordering.

These tests are red against the current single-direction generator.
"""

from __future__ import annotations

from datetime import UTC, datetime

from app.domain.contracts import Database, GeoSeriesRecord, LiteratureRecord, SourceRecord
from app.pipeline.stages.artifact_build.relations import build_source_relations

_GEO_URL = "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE178352"


def _sources(
    pubmed_id: str = "src_pubmed_34180400",
    geo_id: str = "src_geo_gse178352",
) -> list[SourceRecord]:
    return [
        SourceRecord(
            source_id=pubmed_id,
            database=Database.PUBMED,
            accession="34180400",
            url="https://pubmed.ncbi.nlm.nih.gov/34180400/",
            title="Primary article",
            retrieved_at=datetime.now(UTC),
        ),
        SourceRecord(
            source_id=geo_id,
            database=Database.GEO,
            accession="GSE178352",
            url=_GEO_URL,
            title="GSE178352 series",
            retrieved_at=datetime.now(UTC),
        ),
    ]


def _literature(pmid: str = "34180400") -> LiteratureRecord:
    return LiteratureRecord(
        pmid=pmid,
        pmcid=None,
        doi=None,
        title="Primary article",
        authors=[],
        journal="",
        published_at=None,
        abstract="",
        source_url="https://pubmed.ncbi.nlm.nih.gov/34180400/",
    )


def _geo(pubmed_ids: list[str] | None = None) -> GeoSeriesRecord:
    return GeoSeriesRecord(
        uid="200178352",
        accession="GSE178352",
        title="GSE178352 series",
        summary="",
        organism="Homo sapiens",
        experiment_type="Expression profiling by high throughput sequencing",
        sample_count=0,
        samples=[],
        platform_ids=["GPL24676"],
        pubmed_ids=pubmed_ids or [],
        bioproject=None,
        ftp_root="",
    )


def test_evidenced_primary_pair_emits_exactly_two_inverse_rows() -> None:
    """An evidenced acquired PMID must produce exactly two rows: the
    article_describes_dataset edge and its inverse dataset_described_by_article."""
    sources = _sources()
    relations = build_source_relations(
        sources=sources,
        literature=_literature(),
        geo=_geo(pubmed_ids=["34180400"]),
        geo_url=_GEO_URL,
    )
    assert len(relations) == 2

    by_type = {row["relation_type"]: row for row in relations}
    forward = by_type["article_describes_dataset"]
    inverse = by_type["dataset_described_by_article"]

    # forward: acquired PubMed source -> GEO source
    assert forward["from_source_id"] == "src_pubmed_34180400"
    assert forward["to_source_id"] == "src_geo_gse178352"
    assert forward["evidence_type"] == "geo_pubmed_id"
    assert forward["evidence_value"] == "34180400"
    assert forward["evidence_url"] == _GEO_URL

    # inverse: GEO source -> acquired PubMed source, same evidence
    assert inverse["from_source_id"] == "src_geo_gse178352"
    assert inverse["to_source_id"] == "src_pubmed_34180400"
    assert inverse["evidence_type"] == "geo_pubmed_id"
    assert inverse["evidence_value"] == "34180400"
    assert inverse["evidence_url"] == _GEO_URL

    # Each direction has a unique relation_id.
    assert forward["relation_id"] != inverse["relation_id"]


def test_external_pmid_pair_is_bidirectional() -> None:
    """Each external (not acquired) PMID yields two rows: GEO ->
    ext:pubmed:<pmid> and its inverse ext:pubmed:<pmid> -> GEO."""
    sources = _sources()
    relations = build_source_relations(
        sources=sources,
        literature=_literature(),
        geo=_geo(pubmed_ids=["12345678"]),
        geo_url=_GEO_URL,
    )
    assert len(relations) == 2

    by_type = {row["relation_type"]: row for row in relations}
    forward = by_type["geo_references_pubmed"]
    inverse = by_type["pubmed_referenced_by_geo"]

    assert forward["from_source_id"] == "src_geo_gse178352"
    assert forward["to_source_id"] == "ext:pubmed:12345678"
    assert forward["evidence_value"] == "12345678"

    assert inverse["from_source_id"] == "ext:pubmed:12345678"
    assert inverse["to_source_id"] == "src_geo_gse178352"
    assert inverse["evidence_value"] == "12345678"
    assert inverse["evidence_type"] == "geo_pubmed_id"
    assert inverse["evidence_url"] == _GEO_URL


def test_combined_primary_and_externals_yields_two_rows_per_pair() -> None:
    """1 evidenced primary + 2 external PMIDs -> 6 rows, two per pair."""
    sources = _sources()
    relations = build_source_relations(
        sources=sources,
        literature=_literature(),
        geo=_geo(pubmed_ids=["34180400", "12345678", "87654321"]),
        geo_url=_GEO_URL,
    )
    assert len(relations) == 6

    from collections import Counter

    counts = Counter(row["relation_type"] for row in relations)
    assert counts == {
        "article_describes_dataset": 1,
        "dataset_described_by_article": 1,
        "geo_references_pubmed": 2,
        "pubmed_referenced_by_geo": 2,
    }
    # relation_ids are unique across all rows.
    ids = [row["relation_id"] for row in relations]
    assert len(ids) == len(set(ids))


def test_no_evidence_produces_no_edges() -> None:
    """An unsubstantiated article->dataset link must not fabricate edges:
    neither direction is emitted when the acquired PMID is not evidenced."""
    sources = _sources()
    relations = build_source_relations(
        sources=sources,
        literature=_literature(pmid="99999999"),
        geo=_geo(pubmed_ids=[]),
        geo_url=_GEO_URL,
    )
    assert relations == []
    # An entirely empty pubmed_ids list also yields no rows.
    relations = build_source_relations(
        sources=sources,
        literature=_literature(),
        geo=_geo(pubmed_ids=[]),
        geo_url=_GEO_URL,
    )
    assert relations == []


def test_dedup_and_stable_ordering() -> None:
    """Duplicate PMID occurrences must not duplicate rows, and the output is
    sorted by the dedup key (from, to, relation_type, evidence_type,
    evidence_value) so identical input yields identical output."""
    sources = _sources()
    dup_geo = _geo(pubmed_ids=["34180400", "34180400", "12345678", "12345678"])
    relations = build_source_relations(
        sources=sources,
        literature=_literature(),
        geo=dup_geo,
        geo_url=_GEO_URL,
    )
    # Duplicates collapse: 1 primary pair + 1 external pair.
    assert len(relations) == 4

    from collections import Counter

    counts = Counter(row["relation_type"] for row in relations)
    assert counts == {
        "article_describes_dataset": 1,
        "dataset_described_by_article": 1,
        "geo_references_pubmed": 1,
        "pubmed_referenced_by_geo": 1,
    }

    def dedup_key(row: dict[str, object]) -> tuple[str, str, str, str, str]:
        return (
            str(row["from_source_id"]),
            str(row["to_source_id"]),
            str(row["relation_type"]),
            str(row["evidence_type"]),
            str(row["evidence_value"]),
        )

    keys = [dedup_key(row) for row in relations]
    assert keys == sorted(keys)

    # Deterministic: a second call returns byte-identical rows.
    again = build_source_relations(
        sources=sources,
        literature=_literature(),
        geo=dup_geo,
        geo_url=_GEO_URL,
    )
    assert again == relations


def test_related_series_edges_require_evidence_and_are_bidirectional() -> None:
    """GSE/GSE edges only with explicit related_series evidence; each
    evidenced pair yields two rows (both directions)."""
    sources = _sources()
    relations = build_source_relations(
        sources=sources,
        literature=_literature(),
        geo=_geo(pubmed_ids=["34180400"]),
        geo_url=_GEO_URL,
        related_series={"GSE178352": ["GSE999999"]},
    )
    series_rows = [
        row for row in relations if row["relation_type"] == "related_series"
    ]
    assert len(series_rows) == 2

    by_from = {row["from_source_id"]: row for row in series_rows}
    forward = by_from["src_geo_gse178352"]
    assert forward["to_source_id"] == "ext:geo:GSE999999"

    inverse = by_from["ext:geo:GSE999999"]
    assert inverse["to_source_id"] == "src_geo_gse178352"

    # Without evidence no GSE/GSE edge appears.
    relations = build_source_relations(
        sources=sources,
        literature=_literature(),
        geo=_geo(pubmed_ids=["34180400"]),
        geo_url=_GEO_URL,
    )
    assert all(row["relation_type"] != "related_series" for row in relations)


def test_v1_alias_emits_bidirectional_rows() -> None:
    """The V1 entry point (``_build_source_relations``) shares the same
    bidirectional generator — no semantic drift."""
    from app.pipeline.stages.artifact_build import _build_source_relations

    sources = _sources()
    relations = _build_source_relations(
        sources=sources,
        literature=_literature(),
        geo=_geo(pubmed_ids=["34180400"]),
        geo_url=_GEO_URL,
    )
    assert {row["relation_type"] for row in relations} == {
        "article_describes_dataset",
        "dataset_described_by_article",
    }
    assert len(relations) == 2
