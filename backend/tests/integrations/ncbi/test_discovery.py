from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.integrations.ncbi.discovery import (
    describe_geo_series,
    search_geo_series,
    search_pubmed,
)


FIXTURE_DIR = (
    Path(__file__).parents[2] / "fixtures" / "ncbi" / "gse178352"
)


def fixture_bytes(name: str) -> bytes:
    return (FIXTURE_DIR / name).read_bytes()


class FixtureClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    async def esearch(self, **kwargs) -> bytes:
        self.calls.append(("esearch", kwargs))
        return (
            fixture_bytes("pubmed_esearch.json")
            if kwargs["db"] == "pubmed"
            else fixture_bytes("geo_esearch.json")
        )

    async def esummary(self, **kwargs) -> bytes:
        self.calls.append(("esummary", kwargs))
        return fixture_bytes("geo_esummary.json")

    async def efetch(self, **kwargs) -> bytes:
        self.calls.append(("efetch", kwargs))
        return fixture_bytes("pubmed_34180400.xml")


@pytest.mark.asyncio
async def test_search_pubmed_returns_records_in_esearch_order() -> None:
    client = FixtureClient()

    result = await search_pubmed(client, "Hsp70 breast cancer", max_results=20)

    assert result.query == "Hsp70 breast cancer"
    assert result.query_translation == "34180400[UID]"
    assert result.total_count == 1
    assert [record.pmid for record in result.records] == ["34180400"]
    assert client.calls == [
        ("esearch", {"db": "pubmed", "term": "Hsp70 breast cancer", "retmax": 20}),
        ("efetch", {"db": "pubmed", "ids": ["34180400"], "retmode": "xml"}),
    ]


@pytest.mark.asyncio
async def test_empty_pubmed_search_does_not_call_efetch() -> None:
    class EmptyClient(FixtureClient):
        async def esearch(self, **kwargs) -> bytes:
            self.calls.append(("esearch", kwargs))
            return json.dumps({
                "esearchresult": {
                    "count": "0",
                    "retmax": "0",
                    "retstart": "0",
                    "idlist": [],
                    "querytranslation": "none",
                }
            }).encode()

    client = EmptyClient()

    result = await search_pubmed(client, "no result", max_results=5)

    assert result.records == []
    assert [name for name, _ in client.calls] == ["esearch"]


@pytest.mark.asyncio
async def test_search_geo_resolves_numeric_uids_before_returning_accessions() -> None:
    client = FixtureClient()

    result = await search_geo_series(client, "GSE178352[Accession]", max_results=20)

    assert result.total_count == 14
    assert [record.accession for record in result.records] == ["GSE178352"]
    summary_call = client.calls[1]
    assert summary_call[0] == "esummary"
    assert summary_call[1]["db"] == "gds"
    assert summary_call[1]["ids"][0] == "200178352"
    assert all(uid.isdigit() for uid in summary_call[1]["ids"])


@pytest.mark.asyncio
async def test_describe_geo_series_finds_exact_accession_and_sample_evidence() -> None:
    client = FixtureClient()

    record = await describe_geo_series(client, "gse178352")

    assert record.accession == "GSE178352"
    assert record.sample_count == 12
    assert record.pubmed_ids == ["34180400"]
    assert client.calls[0] == (
        "esearch",
        {"db": "gds", "term": "GSE178352[Accession]", "retmax": 100},
    )


@pytest.mark.asyncio
async def test_describe_geo_series_rejects_non_gse_accession_before_network() -> None:
    client = FixtureClient()

    with pytest.raises(ValueError, match="GSE accession"):
        await describe_geo_series(client, "200178352")

    assert client.calls == []


def search_payload(ids: list[str]) -> bytes:
    return json.dumps({
        "esearchresult": {
            "count": str(len(ids)),
            "retmax": str(len(ids)),
            "retstart": "0",
            "idlist": ids,
            "querytranslation": "batch test",
        }
    }).encode()


def pubmed_xml(ids: list[str]) -> bytes:
    articles = "".join(
        "<PubmedArticle><MedlineCitation>"
        f"<PMID>{pmid}</PMID><Article><ArticleTitle>Title {pmid}</ArticleTitle>"
        "</Article></MedlineCitation><PubmedData><ArticleIdList>"
        f'<ArticleId IdType="pubmed">{pmid}</ArticleId>'
        "</ArticleIdList></PubmedData></PubmedArticle>"
        for pmid in ids
    )
    return f"<PubmedArticleSet>{articles}</PubmedArticleSet>".encode()


def geo_summary(ids: list[str]) -> bytes:
    result = {
        uid: {
            "uid": uid,
            "accession": f"GSE{uid}",
            "entrytype": "GSE",
            "n_samples": 0,
            "samples": [],
        }
        for uid in ids
    }
    result["uids"] = ids
    return json.dumps({"result": result}).encode()


@pytest.mark.asyncio
async def test_pubmed_discovery_batches_more_than_200_ids() -> None:
    ids = [str(value) for value in range(1, 202)]

    class BatchClient(FixtureClient):
        async def esearch(self, **kwargs) -> bytes:
            return search_payload(ids)

        async def efetch(self, **kwargs) -> bytes:
            self.calls.append(("efetch", kwargs))
            return pubmed_xml(kwargs["ids"])

    client = BatchClient()
    result = await search_pubmed(client, "batch", max_results=201)

    fetch_calls = [call for call in client.calls if call[0] == "efetch"]
    assert [len(call[1]["ids"]) for call in fetch_calls] == [200, 1]
    assert [record.pmid for record in result.records] == ids


@pytest.mark.asyncio
async def test_geo_discovery_batches_more_than_200_uids() -> None:
    ids = [str(value) for value in range(1, 202)]

    class BatchClient(FixtureClient):
        async def esearch(self, **kwargs) -> bytes:
            return search_payload(ids)

        async def esummary(self, **kwargs) -> bytes:
            self.calls.append(("esummary", kwargs))
            return geo_summary(kwargs["ids"])

    client = BatchClient()
    result = await search_geo_series(client, "batch", max_results=201)

    summary_calls = [call for call in client.calls if call[0] == "esummary"]
    assert [len(call[1]["ids"]) for call in summary_calls] == [200, 1]
    assert len(result.records) == 201
