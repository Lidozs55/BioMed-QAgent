"""Deterministic orchestration of NCBI discovery calls and pure parsers."""

from __future__ import annotations

import re
from typing import Protocol

from app.domain.contracts.discovery import (
    GeoSearchResult,
    GeoSeriesRecord,
    PubMedSearchResult,
)
from app.integrations.ncbi.parsers import (
    parse_geo_esummary,
    parse_ncbi_esearch,
    parse_pubmed_xml,
)

_BATCH_SIZE = 200


class NcbiDiscoveryClient(Protocol):
    async def esearch(self, *, db: str, term: str, retmax: int) -> bytes: ...

    async def esummary(self, *, db: str, ids: list[str]) -> bytes: ...

    async def efetch(
        self, *, db: str, ids: list[str], retmode: str
    ) -> bytes: ...


def _batches(values: list[str]) -> list[list[str]]:
    return [
        values[index:index + _BATCH_SIZE]
        for index in range(0, len(values), _BATCH_SIZE)
    ]


async def search_pubmed(
    client: NcbiDiscoveryClient,
    query: str,
    max_results: int,
) -> PubMedSearchResult:
    search_payload = await client.esearch(
        db="pubmed", term=query, retmax=max_results
    )
    page = parse_ncbi_esearch(search_payload)
    selected_ids = page.ids[:max_results]
    records_by_pmid = {}
    for batch in _batches(selected_ids):
        fetch_payload = await client.efetch(
            db="pubmed", ids=batch, retmode="xml"
        )
        records_by_pmid.update({
            record.pmid: record for record in parse_pubmed_xml(fetch_payload)
        })
    ordered_records = [
        records_by_pmid[pmid]
        for pmid in selected_ids
        if pmid in records_by_pmid
    ]
    return PubMedSearchResult(
        query=query,
        query_translation=page.query_translation,
        total_count=page.count,
        records=ordered_records,
    )


async def search_geo_series(
    client: NcbiDiscoveryClient,
    query: str,
    max_results: int,
) -> GeoSearchResult:
    search_payload = await client.esearch(db="gds", term=query, retmax=max_results)
    page = parse_ncbi_esearch(search_payload)
    selected_ids = page.ids[:max_results]
    records: list[GeoSeriesRecord] = []
    for batch in _batches(selected_ids):
        summary_payload = await client.esummary(db="gds", ids=batch)
        records.extend(parse_geo_esummary(summary_payload))

    unique_records: list[GeoSeriesRecord] = []
    seen_accessions: set[str] = set()
    for record in records:
        if record.accession in seen_accessions:
            continue
        seen_accessions.add(record.accession)
        unique_records.append(record)
    return GeoSearchResult(
        query=query,
        query_translation=page.query_translation,
        total_count=page.count,
        records=unique_records,
    )


async def describe_geo_series(
    client: NcbiDiscoveryClient,
    accession: str,
) -> GeoSeriesRecord:
    normalized = accession.strip().upper()
    if not re.fullmatch(r"GSE\d+", normalized):
        raise ValueError("accession must be a GSE accession")
    result = await search_geo_series(
        client,
        query=f"{normalized}[Accession]",
        max_results=100,
    )
    for record in result.records:
        if record.accession == normalized:
            return record
    raise LookupError(f"GEO series not found: {normalized}")
