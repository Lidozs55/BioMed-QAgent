"""Build the pinned PMID 34180400 / GSE178352 offline fixture from NCBI.

This is a maintainer command, not part of the default test suite. It preserves
the official response bytes and the first five decompressed physical lines of
the processed-counts asset, then records checksums for independent verification.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable


EUTILS_IDENTITY = "&tool=BioMedQAgent&email=biomed-qagent%40example.com"
PUBMED_SEARCH_URL = (
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
    "?db=pubmed&term=34180400%5BPMID%5D&retmax=1&retmode=json"
    f"{EUTILS_IDENTITY}"
)
PUBMED_URL = (
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"
    "?db=pubmed&id=34180400&retmode=xml"
    f"{EUTILS_IDENTITY}"
)
GEO_SEARCH_URL = (
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
    "?db=gds&term=GSE178352%5BAccession%5D&retmode=json"
    f"{EUTILS_IDENTITY}"
)
GEO_SUMMARY_URL = (
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi"
    "?db=gds&id=200178352&retmode=json"
    f"{EUTILS_IDENTITY}"
)
GEO_SUPPL_LISTING_URL = (
    "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE178nnn/GSE178352/suppl/"
)
GEO_SOFT_URL = (
    "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE178nnn/GSE178352/"
    "soft/GSE178352_family.soft.gz"
)
COUNTS_URL = (
    "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE178nnn/GSE178352/"
    "suppl/GSE178352_tximportCounts.txt.gz"
)
COUNTS_SIZE = 4_597_797
COUNTS_SHA256 = (
    "71e78e43fbd0db021c243feb8d935850d2c95bbfeba884d42f6dd78bfa753a55"
)
SOFT_SIZE = 2_986
SOFT_SHA256 = "cc68bf34f789bce16121adb306a8ea1a80c08c19874d62920813e3265ea39c88"
USER_AGENT = "BioMed-QAgent/0.1 fixture-builder (research data verification)"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def download(
    url: str,
    *,
    opener: Callable[..., object] = urllib.request.urlopen,
    sleeper: Callable[[float], None] = time.sleep,
) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(4):
        try:
            with opener(request, timeout=120) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            retryable = error.code == 429 or 500 <= error.code < 600
            if not retryable or attempt == 3:
                raise
            retry_after = float(error.headers.get("Retry-After", "0"))
            sleeper(max(2.0**attempt, retry_after))
    raise RuntimeError("unreachable")


def write_bytes(output_dir: Path, name: str, data: bytes) -> str:
    (output_dir / name).write_bytes(data)
    return sha256_bytes(data)


def source_metadata(url: str, data: bytes, media_type: str) -> dict[str, object]:
    parsed = urllib.parse.urlsplit(url)
    return {
        "url": url,
        "request_parameters": urllib.parse.parse_qs(
            parsed.query, keep_blank_values=True
        ),
        "media_type": media_type,
        "size_bytes": len(data),
        "sha256": sha256_bytes(data),
    }


def extract_gzip_lines(compressed: bytes, line_count: int) -> bytes:
    """Return exact decompressed physical lines without a filesystem reopen."""

    with gzip.GzipFile(fileobj=io.BytesIO(compressed), mode="rb") as source:
        return b"".join(source.readline() for _ in range(line_count))


def build_fixture(output_dir: Path, retrieved_at: datetime) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)

    downloaded: dict[str, tuple[str, bytes]] = {}
    for name, url in (
        ("pubmed_esearch.json", PUBMED_SEARCH_URL),
        ("pubmed_34180400.xml", PUBMED_URL),
        ("geo_esearch.json", GEO_SEARCH_URL),
        ("geo_esummary.json", GEO_SUMMARY_URL),
        ("geo_suppl_listing.html", GEO_SUPPL_LISTING_URL),
        ("gse178352_family.soft.gz", GEO_SOFT_URL),
        ("counts.gz", COUNTS_URL),
    ):
        downloaded[name] = (url, download(url))
        time.sleep(0.5)

    counts_bytes = downloaded["counts.gz"][1]
    if len(counts_bytes) != COUNTS_SIZE:
        raise RuntimeError(
            f"official counts size changed: {len(counts_bytes)} != {COUNTS_SIZE}"
        )
    if sha256_bytes(counts_bytes) != COUNTS_SHA256:
        raise RuntimeError("official counts SHA-256 changed")
    soft_bytes = downloaded["gse178352_family.soft.gz"][1]
    if len(soft_bytes) != SOFT_SIZE or sha256_bytes(soft_bytes) != SOFT_SHA256:
        raise RuntimeError("official family SOFT bytes changed")

    slice_bytes = extract_gzip_lines(counts_bytes, line_count=5)

    fixture_bytes = {
        "pubmed_esearch.json": downloaded["pubmed_esearch.json"][1],
        "pubmed_34180400.xml": downloaded["pubmed_34180400.xml"][1],
        "geo_esearch.json": downloaded["geo_esearch.json"][1],
        "geo_esummary.json": downloaded["geo_esummary.json"][1],
        "geo_suppl_listing.html": downloaded["geo_suppl_listing.html"][1],
        "gse178352_family.soft.gz": soft_bytes,
        "tximport_counts_slice.tsv": slice_bytes,
    }
    fixture_sha256 = {
        name: write_bytes(output_dir, name, data)
        for name, data in sorted(fixture_bytes.items())
    }
    sources = {
        "geo_esearch": source_metadata(
            GEO_SEARCH_URL, downloaded["geo_esearch.json"][1], "application/json"
        ),
        "geo_esummary": source_metadata(
            GEO_SUMMARY_URL, downloaded["geo_esummary.json"][1], "application/json"
        ),
        "geo_supplementary_listing": source_metadata(
            GEO_SUPPL_LISTING_URL,
            downloaded["geo_suppl_listing.html"][1],
            "text/html",
        ),
        "geo_family_soft": source_metadata(
            GEO_SOFT_URL, soft_bytes, "application/gzip"
        ),
        "pubmed": source_metadata(
            PUBMED_URL, downloaded["pubmed_34180400.xml"][1], "application/xml"
        ),
        "pubmed_esearch": source_metadata(
            PUBMED_SEARCH_URL,
            downloaded["pubmed_esearch.json"][1],
            "application/json",
        ),
        "tximport_counts": {
            **source_metadata(COUNTS_URL, counts_bytes, "application/gzip"),
            "data_level": "repository_processed",
            "logical_file": "GSE178352_tximportCounts.txt",
        },
    }
    geo_summary = json.loads(downloaded["geo_esummary.json"][1])
    samples = geo_summary["result"]["200178352"]["samples"]
    manifest = {
        "schema_version": "1.0",
        "builder_version": "1.0",
        "case_id": "pmid34180400_gse178352",
        "retrieved_at": retrieved_at.astimezone(timezone.utc).isoformat(),
        "sources": sources,
        "fixture_sha256": fixture_sha256,
        "fixture_size_bytes": {
            name: len(data) for name, data in sorted(fixture_bytes.items())
        },
        "sample_accessions": [sample["accession"] for sample in samples],
        "relations": [{
            "from": "PMID:34180400",
            "to": "GEO:GSE178352",
            "evidence_source": "geo_esummary.json",
            "evidence_value": "34180400",
        }],
        "retained_source_lines": [1, 2, 3, 4, 5],
        "retained_data_columns": list(range(38)),
        "fixture_row_count": 4,
        "fixture_header_field_count": 37,
        "fixture_data_field_count": 38,
        "extraction_command": (
            "uv run python scripts/build_gse178352_fixture.py "
            "--output-dir tests/fixtures/ncbi/gse178352"
        ),
    }
    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return manifest_path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("tests/fixtures/ncbi/gse178352"),
    )
    parser.add_argument(
        "--retrieved-at",
        type=datetime.fromisoformat,
        default=datetime.now(timezone.utc),
    )
    arguments = parser.parse_args()
    print(build_fixture(arguments.output_dir, arguments.retrieved_at))


if __name__ == "__main__":
    main()
