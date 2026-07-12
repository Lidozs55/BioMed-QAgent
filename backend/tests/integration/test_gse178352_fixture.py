from __future__ import annotations

import csv
import gzip
import hashlib
import json
from pathlib import Path
import urllib.error

from scripts.build_gse178352_fixture import download, extract_gzip_lines


FIXTURE_DIR = Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"
FULL_COUNTS_SHA256 = (
    "71e78e43fbd0db021c243feb8d935850d2c95bbfeba884d42f6dd78bfa753a55"
)


def test_extract_gzip_lines_reads_from_memory_without_reopening_temp_file() -> None:
    compressed = gzip.compress(b"first\nsecond\nthird\n")

    assert extract_gzip_lines(compressed, line_count=2) == b"first\nsecond\n"


def test_fixture_download_retries_http_429() -> None:
    calls = 0
    delays: list[float] = []

    class Response:
        def __enter__(self) -> "Response":
            return self

        def __exit__(self, *args: object) -> None:
            return None

        def read(self) -> bytes:
            return b"official response"

    def opener(request: object, timeout: int) -> Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise urllib.error.HTTPError(
                "https://example.test",
                429,
                "Too Many Requests",
                {"Retry-After": "0"},
                None,
            )
        return Response()

    assert download(
        "https://example.test",
        opener=opener,
        sleeper=delays.append,
    ) == b"official response"
    assert calls == 2
    assert delays == [1.0]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(64 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def test_fixture_manifest_verifies_every_fixture_file() -> None:
    manifest = json.loads((FIXTURE_DIR / "manifest.json").read_text("utf-8"))

    assert manifest["schema_version"] == "1.0"
    assert manifest["case_id"] == "pmid34180400_gse178352"
    assert manifest["retained_source_lines"] == [1, 2, 3, 4, 5]
    assert manifest["retained_data_columns"] == list(range(38))
    assert set(manifest["fixture_sha256"]) == {
        "geo_esearch.json",
        "geo_esummary.json",
        "geo_suppl_listing.html",
        "pubmed_34180400.xml",
        "pubmed_esearch.json",
        "tximport_counts_slice.tsv",
    }
    for name, expected_sha256 in manifest["fixture_sha256"].items():
        assert sha256_file(FIXTURE_DIR / name) == expected_sha256


def test_manifest_pins_the_complete_official_counts_asset() -> None:
    manifest = json.loads((FIXTURE_DIR / "manifest.json").read_text("utf-8"))
    source = manifest["sources"]["tximport_counts"]

    assert source["url"] == (
        "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE178nnn/GSE178352/"
        "suppl/GSE178352_tximportCounts.txt.gz"
    )
    assert source["size_bytes"] == 4_597_797
    assert source["sha256"] == FULL_COUNTS_SHA256
    assert source["data_level"] == "repository_processed"


def test_counts_slice_preserves_the_irregular_official_header() -> None:
    with (FIXTURE_DIR / "tximport_counts_slice.tsv").open(
        "r", encoding="utf-8", newline=""
    ) as handle:
        rows = list(csv.reader(handle, delimiter="\t", quotechar='"'))

    # The official file has no header token for its leading Ensembl ID field:
    # 37 header tokens but 38 tokens in each data line.
    assert len(rows) == 5
    assert len(rows[0]) == 37
    assert len(rows[1]) == 38
    assert rows[1][0] == "ENSG00000000003"
    assert len([field for field in rows[0] if field.startswith("counts.")]) == 12
    assert rows[0][-1] == "countsFromAbundance"


def test_discovery_and_listing_fixtures_contain_pinned_identifiers() -> None:
    pubmed_search = json.loads(
        (FIXTURE_DIR / "pubmed_esearch.json").read_text("utf-8")
    )
    listing = (FIXTURE_DIR / "geo_suppl_listing.html").read_text("utf-8")

    assert pubmed_search["esearchresult"]["idlist"] == ["34180400"]
    assert "GSE178352_tximportCounts.txt.gz" in listing


def test_manifest_records_case_relationship_and_sample_evidence() -> None:
    manifest = json.loads((FIXTURE_DIR / "manifest.json").read_text("utf-8"))

    assert manifest["builder_version"] == "1.0"
    assert len(manifest["sample_accessions"]) == 12
    assert len(set(manifest["sample_accessions"])) == 12
    assert manifest["relations"] == [{
        "from": "PMID:34180400",
        "to": "GEO:GSE178352",
        "evidence_source": "geo_esummary.json",
        "evidence_value": "34180400",
    }]
    assert set(manifest["fixture_size_bytes"]) == set(manifest["fixture_sha256"])
    for source in manifest["sources"].values():
        assert "request_parameters" in source
        assert "media_type" in source
