from __future__ import annotations

import json
from datetime import date
from pathlib import Path

from app.domain.contracts import DataLevel
from app.integrations.ncbi.parsers import (
    parse_geo_esearch,
    parse_geo_esummary,
    parse_ncbi_esearch,
    parse_pubmed_xml,
    resolve_geo_supplementary_assets,
)

FIXTURE_DIR = (
    Path(__file__).parents[2] / "fixtures" / "ncbi" / "gse178352"
)


def fixture_bytes(name: str) -> bytes:
    return (FIXTURE_DIR / name).read_bytes()


def test_parse_pubmed_xml_preserves_primary_article_metadata() -> None:
    records = parse_pubmed_xml(fixture_bytes("pubmed_34180400.xml"))

    assert len(records) == 1
    record = records[0]
    assert record.pmid == "34180400"
    assert record.pmcid == "PMC8275131"
    assert record.doi == "10.7554/eLife.64977"
    assert record.title == (
        "Unique integrated stress response sensors regulate cancer cell "
        "susceptibility when Hsp70 activity is compromised."
    )
    assert record.authors[0] == "Sara Sannino"
    assert len(record.authors) == 7
    assert record.journal == "eLife"
    assert record.published_at == date(2021, 6, 28)
    assert "Molecular chaperones" in record.abstract
    assert record.source_url == "https://pubmed.ncbi.nlm.nih.gov/34180400/"


def test_parse_geo_esearch_keeps_numeric_uids_distinct_from_accessions() -> None:
    page = parse_geo_esearch(fixture_bytes("geo_esearch.json"))

    assert page.count == 14
    assert page.ids[0] == "200178352"
    assert all(uid.isdigit() for uid in page.ids)
    assert page.query_translation == "GSE178352[Accession]"
    assert not hasattr(page, "accessions")


def test_parse_ncbi_esearch_is_shared_with_pubmed() -> None:
    page = parse_ncbi_esearch(fixture_bytes("pubmed_esearch.json"))

    assert page.ids == ["34180400"]
    assert page.count == 1
    assert page.query_translation == "34180400[UID]"


def test_parse_geo_esummary_maps_series_uid_to_typed_gse_record() -> None:
    records = parse_geo_esummary(fixture_bytes("geo_esummary.json"))

    assert len(records) == 1
    record = records[0]
    assert record.uid == "200178352"
    assert record.accession == "GSE178352"
    assert record.organism == "Homo sapiens"
    assert record.experiment_type == "Expression profiling by high throughput sequencing"
    assert record.sample_count == 12
    assert len(record.samples) == 12
    assert len({sample.accession for sample in record.samples}) == 12
    assert record.samples[0].accession == "GSM5388281"
    assert record.platform_ids == ["GPL24676"]
    assert record.pubmed_ids == ["34180400"]
    assert record.bioproject == "PRJNA738534"
    assert record.ftp_root.endswith("/GSE178352/")


def test_parse_geo_esummary_tolerates_empty_n_samples() -> None:
    """A GSE record with ``n_samples=""`` must not abort the whole batch.

    NCBI esummary occasionally returns an empty string for ``n_samples``; a
    bare ``int("")`` raises ValueError and drops every record in the batch.
    The parser must fall back to the sample list length instead.
    (See docs/REVIEW_2026-08-10-task-9ce0124f.md §5.1 T1.)
    """
    payload = fixture_bytes("geo_esummary.json")
    data = json.loads(payload.decode("utf-8-sig"))
    data["result"]["200178352"]["n_samples"] = ""
    records = parse_geo_esummary(json.dumps(data).encode("utf-8"))

    assert len(records) == 1
    assert records[0].sample_count == 12  # falls back to len(samples)


def test_supplementary_listing_resolver_finds_counts_asset_separately() -> None:
    assets = resolve_geo_supplementary_assets(
        fixture_bytes("geo_suppl_listing.html"),
        base_url=(
            "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE178nnn/"
            "GSE178352/suppl/"
        ),
    )

    assert len(assets) == 1
    asset = assets[0]
    assert asset.filename == "GSE178352_tximportCounts.txt.gz"
    assert asset.url.endswith("/GSE178352_tximportCounts.txt.gz")
    assert asset.media_type == "application/gzip"
    assert asset.data_level is DataLevel.REPOSITORY_PROCESSED
