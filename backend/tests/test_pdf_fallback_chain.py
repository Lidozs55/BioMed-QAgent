"""Tests for the 3-tier PDF fallback chain in ``acquire_publication_with_fallback``.

Per TODO §8.4 and the project_memory L1 hard constraint, the chain is:
    pdf_url (direct) → Unpaywall (DOI, 5s quick failure) → EPMC fullTextXML

These tests verify each tier in isolation and the fallback transitions
between tiers. Network calls are mocked via ``monkeypatch`` on the
``lookup_pdf_url`` and ``fetch_full_text_xml`` clients (which create their
own ``httpx.AsyncClient`` internally), and via ``httpx.MockTransport`` for
the ``acquire_source()`` streaming path.
"""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
from app.domain.contracts import (
    Database,
    DataLevel,
    DownloadStatus,
    ErrorCode,
    SourceRecord,
)
from app.integrations import europepmc as epmc_module
from app.integrations import unpaywall as unpaywall_module
from app.integrations.acquisition import (
    AcquisitionFailure,
    acquire_publication_with_fallback,
)
from app.integrations.europepmc import EuropePmcError
from app.integrations.unpaywall import UnpaywallError
from app.tools.content_cache import ContentCache
from app.tools.workdir import create_task_workdir

NOW = datetime(2026, 7, 18, tzinfo=UTC)

PDF_URL = "https://ftp.ncbi.nlm.nih.gov/pub/pmc/PMC7450705.pdf"
LANDING_URL = "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7450705/"
UNPAYWALL_PDF_URL = "https://www.ncbi.nlm.nih.gov/pub/pmc/PMC7450705.pdf"
EPMC_XML_URL = (
    "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC7450705/fullTextXML"
)


def _source(url: str = LANDING_URL) -> SourceRecord:
    return SourceRecord(
        source_id="src_pmc7450705",
        database=Database.PUBMED,
        accession="PMC7450705",
        url=url,
        title="Test publication",
        retrieved_at=NOW,
    )


def _pdf_bytes() -> bytes:
    return b"%PDF-1.5\n%test PDF content for fallback chain\n%%EOF"


def _xml_bytes() -> bytes:
    return (
        b'<?xml version="1.0" encoding="UTF-8"?>'
        b"<article><body>test full text</body></article>"
    )


def _pdf_handler(content: bytes) -> httpx.MockTransport:
    """Return a MockTransport that serves ``content`` for any HTTPS request."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=content,
            headers={
                "Content-Length": str(len(content)),
                "Content-Type": "application/pdf",
            },
        )

    return httpx.MockTransport(handler)


# ---------------------------------------------------------------------------
# Tier 1: direct pdf_url
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_tier1_direct_pdf_url_succeeds(tmp_path: Path) -> None:
    """source.url ending in .pdf is downloaded directly via acquire_source()."""
    content = _pdf_bytes()
    source = _source(url=PDF_URL)
    workdir = create_task_workdir("task_pdf_t1", base_dir=str(tmp_path / "tasks"))
    cache = ContentCache(tmp_path / "cache")

    async with httpx.AsyncClient(transport=_pdf_handler(content)) as http:
        result = await acquire_publication_with_fallback(
            source=source,
            filename="PMC7450705.pdf",
            workdir=workdir,
            cache=cache,
            http=http,
            max_bytes=10 * 1024 * 1024,
            data_level=DataLevel.METADATA,
            doi="10.1234/test",
            pmcid="PMC7450705",
        )

    assert result.attempt.status is DownloadStatus.SUCCEEDED
    assert result.asset is not None
    assert result.asset.media_type == "application/pdf"
    assert result.asset.size_bytes == len(content)
    # Asset filename preserves the .pdf extension (tier 1)
    assert result.asset.relative_path.endswith("PMC7450705.pdf")


@pytest.mark.asyncio
async def test_tier1_skipped_when_source_url_is_landing_page(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Landing-page URLs (not direct PDF links) skip tier 1 and fall through.

    This verifies the ``looks_like_pdf`` heuristic: a URL like
    ``/articles/PMC7450705/`` is NOT treated as a PDF.
    """
    unpaywall_calls: list[str] = []

    async def fake_lookup(doi: str, **kwargs) -> str:
        unpaywall_calls.append(doi)
        return UNPAYWALL_PDF_URL

    monkeypatch.setattr(unpaywall_module, "lookup_pdf_url", fake_lookup)

    content = _pdf_bytes()
    source = _source(url=LANDING_URL)
    workdir = create_task_workdir("task_pdf_skip_t1", base_dir=str(tmp_path / "tasks"))
    cache = ContentCache(tmp_path / "cache")

    async with httpx.AsyncClient(transport=_pdf_handler(content)) as http:
        result = await acquire_publication_with_fallback(
            source=source,
            filename="PMC7450705.pdf",
            workdir=workdir,
            cache=cache,
            http=http,
            max_bytes=10 * 1024 * 1024,
            data_level=DataLevel.METADATA,
            doi="10.1234/test",
            pmcid="PMC7450705",
        )

    # Tier 1 skipped, tier 2 (Unpaywall) succeeded
    assert result.attempt.status is DownloadStatus.SUCCEEDED
    assert unpaywall_calls == ["10.1234/test"]


# ---------------------------------------------------------------------------
# Tier 2: Unpaywall (DOI → pdf_url)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_tier2_unpaywall_succeeds_when_direct_url_not_pdf(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Tier 2: Unpaywall resolves DOI → pdf_url, then acquire_source() downloads."""
    content = _pdf_bytes()

    async def fake_lookup(doi: str, **kwargs) -> str:
        return UNPAYWALL_PDF_URL

    monkeypatch.setattr(unpaywall_module, "lookup_pdf_url", fake_lookup)

    source = _source(url=LANDING_URL)
    workdir = create_task_workdir("task_pdf_t2", base_dir=str(tmp_path / "tasks"))
    cache = ContentCache(tmp_path / "cache")

    async with httpx.AsyncClient(transport=_pdf_handler(content)) as http:
        result = await acquire_publication_with_fallback(
            source=source,
            filename="PMC7450705.pdf",
            workdir=workdir,
            cache=cache,
            http=http,
            max_bytes=10 * 1024 * 1024,
            data_level=DataLevel.METADATA,
            doi="10.1234/test",
            pmcid=None,  # tier 3 disabled
        )

    assert result.attempt.status is DownloadStatus.SUCCEEDED
    assert result.asset is not None
    assert result.asset.media_type == "application/pdf"
    # The download URL should be the Unpaywall-resolved one
    assert result.attempt.url == UNPAYWALL_PDF_URL


@pytest.mark.asyncio
async def test_tier2_skipped_when_no_doi(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Tier 2 is skipped when ``doi=None``; error message records the skip."""
    epmc_calls: list[str] = []

    async def fake_epmc(pmcid: str, **kwargs) -> bytes:
        epmc_calls.append(pmcid)
        return _xml_bytes()

    monkeypatch.setattr(epmc_module, "fetch_full_text_xml", fake_epmc)

    source = _source(url=LANDING_URL)
    workdir = create_task_workdir("task_pdf_no_doi", base_dir=str(tmp_path / "tasks"))
    cache = ContentCache(tmp_path / "cache")

    async with httpx.AsyncClient(transport=_pdf_handler(b"")) as http:
        # No DOI, PMCID provided → tier 1 skipped (landing page),
        # tier 2 skipped (no DOI), tier 3 succeeds
        result = await acquire_publication_with_fallback(
            source=source,
            filename="PMC7450705.pdf",
            workdir=workdir,
            cache=cache,
            http=http,
            max_bytes=10 * 1024 * 1024,
            data_level=DataLevel.METADATA,
            doi=None,
            pmcid="PMC7450705",
        )

    assert result.attempt.status is DownloadStatus.SUCCEEDED
    assert epmc_calls == ["PMC7450705"]
    assert result.asset is not None
    assert result.asset.media_type == "application/xml"


# ---------------------------------------------------------------------------
# Tier 3: Europe PMC (PMCID → fullTextXML)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_tier3_epmc_succeeds_when_unpaywall_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Tier 3: EPMC returns fullTextXML, saved as .xml asset."""
    xml_content = _xml_bytes()

    async def fake_lookup(doi: str, **kwargs) -> str:
        raise UnpaywallError("DOI not found")

    async def fake_epmc(pmcid: str, **kwargs) -> bytes:
        assert pmcid == "PMC7450705"
        return xml_content

    monkeypatch.setattr(unpaywall_module, "lookup_pdf_url", fake_lookup)
    monkeypatch.setattr(epmc_module, "fetch_full_text_xml", fake_epmc)

    source = _source(url=LANDING_URL)
    workdir = create_task_workdir("task_pdf_t3", base_dir=str(tmp_path / "tasks"))
    cache = ContentCache(tmp_path / "cache")

    async with httpx.AsyncClient(transport=_pdf_handler(b"")) as http:
        result = await acquire_publication_with_fallback(
            source=source,
            filename="PMC7450705.pdf",
            workdir=workdir,
            cache=cache,
            http=http,
            max_bytes=10 * 1024 * 1024,
            data_level=DataLevel.METADATA,
            doi="10.1234/test",
            pmcid="PMC7450705",
        )

    assert result.attempt.status is DownloadStatus.SUCCEEDED
    assert result.asset is not None
    assert result.asset.media_type == "application/xml"
    assert result.asset.size_bytes == len(xml_content)
    # Tier 3 saves as .xml (not .pdf)
    assert result.asset.relative_path.endswith(".xml")
    # The attempt URL records the EPMC endpoint
    assert "europepmc" in result.attempt.url
    assert "PMC7450705" in result.attempt.url


@pytest.mark.asyncio
async def test_tier3_xml_checksum_matches_content(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Tier 3 asset sha256 matches the XML bytes returned by EPMC."""
    xml_content = _xml_bytes()
    expected_sha = hashlib.sha256(xml_content).hexdigest()

    async def fake_epmc(pmcid: str, **kwargs) -> bytes:
        return xml_content

    monkeypatch.setattr(epmc_module, "fetch_full_text_xml", fake_epmc)

    source = _source(url=LANDING_URL)
    workdir = create_task_workdir("task_pdf_sha", base_dir=str(tmp_path / "tasks"))
    cache = ContentCache(tmp_path / "cache")

    async with httpx.AsyncClient(transport=_pdf_handler(b"")) as http:
        result = await acquire_publication_with_fallback(
            source=source,
            filename="PMC7450705.pdf",
            workdir=workdir,
            cache=cache,
            http=http,
            max_bytes=10 * 1024 * 1024,
            data_level=DataLevel.METADATA,
            doi=None,
            pmcid="PMC7450705",
        )

    assert result.asset is not None
    assert result.asset.sha256 == expected_sha
    assert result.asset.asset_id == f"asset_{expected_sha}"


# ---------------------------------------------------------------------------
# All tiers fail
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_all_tiers_fail_raises_acquisition_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When all tiers fail, AcquisitionFailure is raised with tier breakdown."""
    failing_pdf_handler = httpx.MockTransport(
        lambda request: httpx.Response(500, content=b"server error")
    )

    async def fake_lookup(doi: str, **kwargs) -> str:
        raise UnpaywallError("no OA version")

    async def fake_epmc(pmcid: str, **kwargs) -> bytes:
        raise EuropePmcError("not found")

    monkeypatch.setattr(unpaywall_module, "lookup_pdf_url", fake_lookup)
    monkeypatch.setattr(epmc_module, "fetch_full_text_xml", fake_epmc)

    source = _source(url=LANDING_URL)
    workdir = create_task_workdir("task_pdf_all_fail", base_dir=str(tmp_path / "tasks"))
    cache = ContentCache(tmp_path / "cache")

    async with httpx.AsyncClient(transport=failing_pdf_handler) as http:
        with pytest.raises(AcquisitionFailure) as exc_info:
            await acquire_publication_with_fallback(
                source=source,
                filename="PMC7450705.pdf",
                workdir=workdir,
                cache=cache,
                http=http,
                max_bytes=10 * 1024 * 1024,
                data_level=DataLevel.METADATA,
                doi="10.1234/test",
                pmcid="PMC7450705",
            )

    message = str(exc_info.value)
    # Error message must mention all three tiers
    assert "tier1_direct" in message
    assert "tier2_unpaywall" in message
    assert "tier3_epmc" in message
    # The exception code is NETWORK_ERROR (terminal failure)
    assert exc_info.value.code is ErrorCode.NETWORK_ERROR


@pytest.mark.asyncio
async def test_no_doi_and_no_pmcid_with_landing_url_fails_after_tier1_skip(
    tmp_path: Path,
) -> None:
    """No DOI and no PMCID: only tier 1 is attempted (and skipped as landing page)."""
    source = _source(url=LANDING_URL)
    workdir = create_task_workdir("task_pdf_no_ids", base_dir=str(tmp_path / "tasks"))
    cache = ContentCache(tmp_path / "cache")

    async with httpx.AsyncClient(transport=_pdf_handler(b"")) as http:
        with pytest.raises(AcquisitionFailure) as exc_info:
            await acquire_publication_with_fallback(
                source=source,
                filename="PMC7450705.pdf",
                workdir=workdir,
                cache=cache,
                http=http,
                max_bytes=10 * 1024 * 1024,
                data_level=DataLevel.METADATA,
                doi=None,
                pmcid=None,
            )

    message = str(exc_info.value)
    assert "tier1_direct: skipped" in message
    assert "tier2_unpaywall: skipped (no DOI provided)" in message
    assert "tier3_epmc: skipped (no PMCID provided)" in message


# ---------------------------------------------------------------------------
# Tier 1 fallback to tier 2 on download failure
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_tier1_download_failure_falls_through_to_tier2(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Tier 1 HTTP 500 → fall through to tier 2 (Unpaywall)."""
    content = _pdf_bytes()
    call_count = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        # First request (tier 1 PDF URL) fails with 500
        if PDF_URL in str(request.url):
            return httpx.Response(500, content=b"server error")
        # Subsequent request (tier 2 Unpaywall URL) succeeds
        return httpx.Response(
            200,
            content=content,
            headers={
                "Content-Length": str(len(content)),
                "Content-Type": "application/pdf",
            },
        )

    async def fake_lookup(doi: str, **kwargs) -> str:
        return UNPAYWALL_PDF_URL

    monkeypatch.setattr(unpaywall_module, "lookup_pdf_url", fake_lookup)

    # Use a source with .pdf URL so tier 1 is attempted
    source = _source(url=PDF_URL)
    workdir = create_task_workdir(
        "task_pdf_t1_fail_t2_ok", base_dir=str(tmp_path / "tasks")
    )
    cache = ContentCache(tmp_path / "cache")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        result = await acquire_publication_with_fallback(
            source=source,
            filename="PMC7450705.pdf",
            workdir=workdir,
            cache=cache,
            http=http,
            max_bytes=10 * 1024 * 1024,
            data_level=DataLevel.METADATA,
            doi="10.1234/test",
            pmcid=None,
        )

    assert result.attempt.status is DownloadStatus.SUCCEEDED
    assert result.attempt.url == UNPAYWALL_PDF_URL
