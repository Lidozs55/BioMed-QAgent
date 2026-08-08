"""Tests for GEO platform annotation parsing and caching (P0-1, 0805)."""

from __future__ import annotations

import gzip
from pathlib import Path

import httpx
import pytest
from app.pipeline.processing.geo_annotation import (
    ANNOTATION_UNAVAILABLE,
    MAPPED,
    NO_GENE_ANNOTATION,
    UNMAPPED,
    discover_annotation_file,
    fetch_platform_annotation,
    geo_platform_dir,
    parse_platform_annotation,
    platform_table_columns,
)
from app.tools.content_cache import ContentCache

PLATFORM_TABLE = """^PLATFORM = GPL99999
!Platform_title = Synthetic test platform
!Platform_table_begin
ID\tNAME\tGENE_SYMBOL\tGENE_NAME\tSEQUENCE
A_19_P00000001\tprobe1\tMETTL5\tmethyltransferase like 5\tACGT
A_19_P00000002\tprobe2\tBRCA1\tBRCA1 DNA repair\tTGCA
A_19_P00000003\tprobe3\t\t\tCCCC
!Platform_table_end
"""

EMPTY_GENE_COLUMNS_TABLE = """^PLATFORM = GPL99999
!Platform_table_begin
ID\tNAME\tGENE_SYMBOL\tGENE_NAME
A_19_P00000001\tprobe1\t\t
A_19_P00000002\tprobe2\t\t
!Platform_table_end
"""

NO_GENE_COLUMN_TABLE = """^PLATFORM = GPL99999
!Platform_table_begin
ID\tNAME\tSEQUENCE
p1\tn1\tACGT
!Platform_table_end
"""


def _gzip(text: str) -> bytes:
    return gzip.compress(text.encode("utf-8"), mtime=0)


# --- geo_platform_dir ------------------------------------------------------


def test_geo_platform_dir_matches_ncbi_ftp_layout() -> None:
    assert geo_platform_dir("GPL19072") == "GPL19nnn"
    assert geo_platform_dir("GPL4133") == "GPL4nnn"
    assert geo_platform_dir("GPL570") == "GPLnnn"
    assert geo_platform_dir("GPL100") == "GPLnnn"


# --- parse_platform_annotation --------------------------------------------


def test_parse_platform_annotation_builds_probe_gene_map() -> None:
    mapping, status = parse_platform_annotation(_gzip(PLATFORM_TABLE))
    assert status == MAPPED
    assert mapping == {
        "A_19_P00000001": "METTL5",
        "A_19_P00000002": "BRCA1",
    }
    # Rows with an empty gene column are skipped, not mapped to "".
    assert "A_19_P00000003" not in mapping


def test_parse_platform_annotation_reports_unmapped_when_gene_columns_empty() -> None:
    """Gene columns exist but carry no values → unmapped (the GPL19072 case
    verified in the 0805 review)."""
    mapping, status = parse_platform_annotation(_gzip(EMPTY_GENE_COLUMNS_TABLE))
    assert status == UNMAPPED
    assert mapping == {}


def test_parse_platform_annotation_reports_no_gene_annotation_without_gene_column() -> None:
    mapping, status = parse_platform_annotation(_gzip(NO_GENE_COLUMN_TABLE))
    assert status == NO_GENE_ANNOTATION
    assert mapping == {}


def test_parse_platform_annotation_reports_no_gene_annotation_without_table() -> None:
    mapping, status = parse_platform_annotation(
        _gzip("^PLATFORM = GPL99999\n!Platform_title = no table\n")
    )
    assert status == NO_GENE_ANNOTATION
    assert mapping == {}


# --- discover_annotation_file ---------------------------------------------

_SUPPL_LISTING = """<!DOCTYPE html><html><body><pre>
<a href="/geo/platforms/GPL99nnn/GPL99999/">Parent Directory</a>
<a href="GPL99999_052909_D_GEO_20130704.txt.gz">GPL99999_052909_D_GEO_20130704.txt.gz</a> 5.6M
</pre></body></html>"""


def _client_for(files: dict[str, bytes]) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        path = str(request.url)
        for url, body in files.items():
            if path == url:
                return httpx.Response(200, content=body)
        return httpx.Response(404)

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_discover_annotation_file_finds_suppl_txt_gz() -> None:
    client = _client_for(
        {"https://ftp.ncbi.nlm.nih.gov/geo/platforms/GPL99nnn/GPL99999/suppl/": _SUPPL_LISTING.encode()}
    )
    assert discover_annotation_file(client, "GPL99999") == (
        "suppl",
        "GPL99999_052909_D_GEO_20130704.txt.gz",
    )


def test_discover_annotation_file_finds_annot_gz_when_no_suppl() -> None:
    annot_listing = (
        '<pre><a href="/geo/platforms/GPL99nnn/GPL99999/">Parent Directory</a>\n'
        '<a href="GPL99999.annot.gz">GPL99999.annot.gz</a>\n</pre>'
    )
    client = _client_for(
        {
            "https://ftp.ncbi.nlm.nih.gov/geo/platforms/GPL99nnn/GPL99999/suppl/": b"",
            "https://ftp.ncbi.nlm.nih.gov/geo/platforms/GPL99nnn/GPL99999/annot/": annot_listing.encode(),
        }
    )
    assert discover_annotation_file(client, "GPL99999") == ("annot", "GPL99999.annot.gz")


def test_discover_annotation_file_returns_none_when_missing() -> None:
    client = _client_for({})
    assert discover_annotation_file(client, "GPL99999") is None


# --- fetch_platform_annotation with cache ---------------------------------


def _fetch_client(blob: bytes) -> httpx.Client:
    listing = (
        '<pre><a href="/geo/platforms/GPL99nnn/GPL99999/">Parent Directory</a>\n'
        '<a href="GPL99999_annot.txt.gz">GPL99999_annot.txt.gz</a>\n</pre>'
    )
    return _client_for(
        {
            "https://ftp.ncbi.nlm.nih.gov/geo/platforms/GPL99nnn/GPL99999/suppl/": listing.encode(),
            "https://ftp.ncbi.nlm.nih.gov/geo/platforms/GPL99nnn/GPL99999/suppl/GPL99999_annot.txt.gz": blob,
        }
    )


def test_fetch_platform_annotation_downloads_and_caches(tmp_path: Path) -> None:
    cache = ContentCache(tmp_path / "cache")
    blob = _gzip(PLATFORM_TABLE)

    mapping, status = fetch_platform_annotation(
        "GPL99999", cache, client=_fetch_client(blob)
    )
    assert status == MAPPED
    assert mapping["A_19_P00000001"] == "METTL5"

    # A second call must hit the cache and never touch the network.
    def boom(_request: httpx.Request) -> httpx.Response:
        raise AssertionError("cache hit must not hit the network")

    client = httpx.Client(transport=httpx.MockTransport(boom))
    mapping2, status2 = fetch_platform_annotation("GPL99999", cache, client=client)
    assert status2 == MAPPED
    assert mapping2 == mapping


def test_fetch_platform_annotation_degrades_on_network_failure(
    tmp_path: Path,
) -> None:
    cache = ContentCache(tmp_path / "cache")

    def fail(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("simulated outage")

    client = httpx.Client(transport=httpx.MockTransport(fail))
    mapping, status = fetch_platform_annotation("GPL99999", cache, client=client)
    assert status == ANNOTATION_UNAVAILABLE
    assert mapping == {}


@pytest.mark.live
def test_live_gpl19072_annotation_reports_unmapped(tmp_path: Path) -> None:
    """Live verification against the real GEO FTP (GPL19072 = GSE102238's
    Agilent platform): the annotation must be discoverable and parseable, and
    — per the 0805 review — must report ``unmapped`` because every gene
    column is empty."""
    cache = ContentCache(tmp_path / "cache")
    mapping, status = fetch_platform_annotation("GPL19072", cache)
    assert status == UNMAPPED
    assert mapping == {}


# --- shared SOFT-table parser parity (review-loop R2b-04) -------------------


def test_v1_v2_platform_parsers_share_single_implementation(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """V1 (parse_platform_annotation / platform_table_columns) and V2
    (probe_mapping.parse_platform_table) must both go through the shared
    :func:`parse_platform_table_text` and agree on the same table.

    If either path re-implemented table parsing, the monkeypatch below would
    not propagate to it and the parity assertions would fail.
    """
    import app.datasets.build.probe_mapping as probe_mapping_mod
    from app.datasets.build.probe_mapping import parse_platform_table
    from app.pipeline.processing import geo_annotation as ga

    calls: list[str] = []
    _original = ga.parse_platform_table_text

    def spy(text: str) -> ga.SoftPlatformTable:
        calls.append("parse_platform_table_text")
        return _original(text)

    monkeypatch.setattr(ga, "parse_platform_table_text", spy)
    # probe_mapping imports the symbol by name, so patch it there too.
    monkeypatch.setattr(
        probe_mapping_mod, "parse_platform_table_text", spy
    )

    annotation_path = tmp_path / "GPL99999.annot.gz"
    annotation_path.write_bytes(_gzip(PLATFORM_TABLE))

    # V1 paths.
    v1_mapping, v1_status = parse_platform_annotation(_gzip(PLATFORM_TABLE))
    v1_probe, v1_gene = platform_table_columns(_gzip(PLATFORM_TABLE))
    # V2 path.
    v2_mapping, v2_namespace, v2_status, v2_ambiguous = parse_platform_table(
        annotation_path
    )

    # Both entry points must have reached the shared parser.
    assert len(calls) == 3, f"shared parser used {len(calls)} times, expected 3"
    # Same gene columns detected.
    assert v1_probe == "ID" and v1_gene == "GENE_SYMBOL"
    assert v2_namespace == "gene_symbol"
    # Same mapping for non-ambiguous probes, same status.
    assert v1_mapping == v2_mapping == {"A_19_P00000001": "METTL5", "A_19_P00000002": "BRCA1"}
    assert v1_status == MAPPED == v2_status
    assert v2_ambiguous == frozenset()
