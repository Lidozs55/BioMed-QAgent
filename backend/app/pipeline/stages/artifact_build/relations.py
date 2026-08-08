"""Source relations CSV building helper (Phase 5 D6: shared bidirectional).

Builds ``source_relations.csv`` rows derived from discovery outputs (TODO
§1.3). This module is the SHARED relation generator used by both the V1
``source_relations.csv`` artifact and the V2 relation audit, so the two
surfaces cannot drift semantically.

D3 contract (bidirectional explicit rows):

* ``SourceRelation`` is a directed edge without a direction field, so every
  evidenced pair emits TWO rows — one per direction, each with a unique
  ``relation_id`` and a stable mutual-inverse ``relation_type``:
  - GSE/PMID (acquired PMID): ``article_describes_dataset`` (PubMed -> GEO)
    and ``dataset_described_by_article`` (GEO -> PubMed);
  - external PMID (referenced but not acquired): ``geo_references_pubmed``
    (GEO -> ``ext:pubmed:<pmid>``) and ``pubmed_referenced_by_geo``
    (``ext:pubmed:<pmid>`` -> GEO).
* GSE/GSE edges are created ONLY with explicit evidence
  (``related_series``, both directions); a shared request is NOT evidence.
* Dedup key ``(from_source_id, to_source_id, relation_type, evidence_type,
  evidence_value)``; rows are emitted sorted by that key so identical input
  yields byte-identical output.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from app.domain.contracts import LiteratureRecord, SourceRecord
from app.domain.contracts.discovery import GeoSeriesRecord

#: Relation types for the acquired PMID pair (mutual inverses, D3).
ARTICLE_DESCRIBES_DATASET = "article_describes_dataset"
DATASET_DESCRIBED_BY_ARTICLE = "dataset_described_by_article"
#: Relation types for the external PMID pair (mutual inverses, D3).
GEO_REFERENCES_PUBMED = "geo_references_pubmed"
PUBMED_REFERENCED_BY_GEO = "pubmed_referenced_by_geo"
#: GSE/GSE edge type; only with explicit related_series evidence (D3).
RELATED_SERIES = "related_series"

#: Evidence type shared by all GSE/PMID edges (D3).
GEO_PUBMED_ID_EVIDENCE = "geo_pubmed_id"
#: Evidence type for GSE/GSE related_series edges (D3).
GEO_RELATED_SERIES_EVIDENCE = "geo_related_series"

#: Stable external identifier prefixes for referenced-but-not-acquired
#: endpoints (keeps the citation graph visible without polluting
#: ``source_list.csv``).
EXT_PUBMED_PREFIX = "ext:pubmed:"
EXT_GEO_PREFIX = "ext:geo:"


def _relation_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Dedupe by ``(from, to, relation_type, evidence_type, evidence_value)``
    and sort by that key for a stable, deterministic emission order."""
    seen: set[tuple[str, str, str, str, str]] = set()
    unique: list[dict[str, Any]] = []
    for row in rows:
        key = (
            str(row["from_source_id"]),
            str(row["to_source_id"]),
            str(row["relation_type"]),
            str(row["evidence_type"]),
            str(row["evidence_value"]),
        )
        if key in seen:
            continue
        seen.add(key)
        unique.append(row)
    unique.sort(
        key=lambda row: (
            str(row["from_source_id"]),
            str(row["to_source_id"]),
            str(row["relation_type"]),
            str(row["evidence_type"]),
            str(row["evidence_value"]),
        )
    )
    return unique


def build_source_relations(
    sources: list[SourceRecord],
    literature: LiteratureRecord | None,
    geo: GeoSeriesRecord,
    geo_url: str,
    *,
    related_series: Mapping[str, Iterable[str]] | None = None,
) -> list[dict[str, object]]:
    """Build bidirectional source-relation rows (Phase 5 D3).

    Replaces the single-direction derivation with an explicit-row model:

    * A primary article→dataset edge is emitted only when the GEO metadata
      explicitly includes the acquired PMID (``geo.pubmed_ids``) — a
      caller-selected, unrelated article and dataset never become a
      fabricated relationship. Each evidenced pair yields BOTH directions.
    * Additional PMIDs referenced by the GEO series but not acquired are
      external citations: ``ext:pubmed:<pmid>`` endpoints, again with both
      directions.
    * ``related_series`` maps a GSE accession to the GSE accessions it
      declares related; each evidenced pair yields two ``related_series``
      rows. Endpoints that are not an acquired source use the stable
      ``ext:geo:<accession>`` identifier. No GSE/GSE edge is created without
      this explicit evidence.

    Rows are deduped by ``(from_source_id, to_source_id, relation_type,
    evidence_type, evidence_value)`` and returned sorted by that key.
    """
    pubmed_source_id = next(
        (s.source_id for s in sources if s.database.value == "pubmed"), None
    )
    geo_source_id = next(
        (s.source_id for s in sources if s.database.value == "geo"), None
    )
    if not geo_source_id:
        return []

    primary_pmid = literature.pmid if literature is not None else None
    primary_is_evidenced = bool(
        pubmed_source_id
        and primary_pmid
        and primary_pmid in geo.pubmed_ids
    )
    rows: list[dict[str, Any]] = []
    if primary_is_evidenced and primary_pmid is not None:
        rows.append(
            {
                "relation_id": f"rel_pmid{primary_pmid}_{geo.accession.lower()}",
                "from_source_id": pubmed_source_id or "",
                "to_source_id": geo_source_id,
                "relation_type": ARTICLE_DESCRIBES_DATASET,
                "evidence_type": GEO_PUBMED_ID_EVIDENCE,
                "evidence_value": primary_pmid,
                "evidence_url": geo_url,
            }
        )
        rows.append(
            {
                "relation_id": f"rel_{geo.accession.lower()}_pmid{primary_pmid}",
                "from_source_id": geo_source_id,
                "to_source_id": pubmed_source_id or "",
                "relation_type": DATASET_DESCRIBED_BY_ARTICLE,
                "evidence_type": GEO_PUBMED_ID_EVIDENCE,
                "evidence_value": primary_pmid,
                "evidence_url": geo_url,
            }
        )

    # External PMIDs: every evidenced GSE×PMID pair outputs two rows.
    seen_pmids = {primary_pmid} if primary_is_evidenced else set()
    for pmid in geo.pubmed_ids:
        if pmid in seen_pmids:
            continue
        seen_pmids.add(pmid)
        external_id = f"{EXT_PUBMED_PREFIX}{pmid}"
        rows.append(
            {
                "relation_id": f"rel_geo_{geo.accession.lower()}_pmid{pmid}",
                "from_source_id": geo_source_id,
                "to_source_id": external_id,
                "relation_type": GEO_REFERENCES_PUBMED,
                "evidence_type": GEO_PUBMED_ID_EVIDENCE,
                "evidence_value": pmid,
                "evidence_url": geo_url,
            }
        )
        rows.append(
            {
                "relation_id": f"rel_pmid{pmid}_geo_{geo.accession.lower()}",
                "from_source_id": external_id,
                "to_source_id": geo_source_id,
                "relation_type": PUBMED_REFERENCED_BY_GEO,
                "evidence_type": GEO_PUBMED_ID_EVIDENCE,
                "evidence_value": pmid,
                "evidence_url": geo_url,
            }
        )

    # GSE/GSE edges require explicit related_series evidence (both directions).
    if related_series:
        for from_accession, related in related_series.items():
            for to_accession in related:
                if to_accession == from_accession:
                    continue
                from_id = _geo_endpoint_id(geo, geo_source_id, from_accession)
                to_id = _geo_endpoint_id(geo, geo_source_id, to_accession)
                rows.append(
                    {
                        "relation_id": (
                            f"rel_{from_accession.lower()}_{to_accession.lower()}"
                        ),
                        "from_source_id": from_id,
                        "to_source_id": to_id,
                        "relation_type": RELATED_SERIES,
                        "evidence_type": GEO_RELATED_SERIES_EVIDENCE,
                        "evidence_value": to_accession,
                        "evidence_url": geo_url,
                    }
                )
                rows.append(
                    {
                        "relation_id": (
                            f"rel_{to_accession.lower()}_{from_accession.lower()}"
                        ),
                        "from_source_id": to_id,
                        "to_source_id": from_id,
                        "relation_type": RELATED_SERIES,
                        "evidence_type": GEO_RELATED_SERIES_EVIDENCE,
                        "evidence_value": from_accession,
                        "evidence_url": geo_url,
                    }
                )

    return _relation_rows(rows)


def _geo_endpoint_id(
    geo: GeoSeriesRecord,
    geo_source_id: str,
    accession: str,
) -> str:
    """Resolve a GSE accession to its acquired source_id when it is the
    acquired series, else the stable ``ext:geo:<accession>`` identifier."""
    if accession.upper() == geo.accession.upper():
        return geo_source_id
    return f"{EXT_GEO_PREFIX}{accession.upper()}"


#: V1 entry point kept as an alias so the artifact builder and existing
#: call sites stay untouched; the shared generator is the single source of
#: truth for both V1 ``source_relations.csv`` and the V2 relation audit.
_build_source_relations = build_source_relations
