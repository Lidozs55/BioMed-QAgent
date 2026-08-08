"""Phase 5 T3: geo.series.v1 / geo.platform.v1 provider layer (D1).

The provider layer owns accession validation, URL construction, download
attempts (size limits / checksum), fixture asset selection and SourceAsset
formation. It is ordinary module functions plus an explicit provider_id
dispatcher — there is NO plugin registry.
"""
from __future__ import annotations

import asyncio
import hashlib
import shutil
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
from app.domain.contracts import Database, DownloadStatus, SourceRecord
from app.pipeline.processing.geo_provider import (
    GEO_PLATFORM_PROVIDER_ID,
    GEO_SERIES_PROVIDER_ID,
    acquire_series_asset,
    normalize_platform_accession,
    normalize_series_accession,
    platform_annot_listing_url,
    platform_dir_prefix,
    platform_file_url,
    platform_landing_url,
    platform_suppl_listing_url,
    resolve_provider,
    select_platform_fixture_asset,
    select_series_fixture_assets,
    series_counts_url,
    series_dir_prefix,
    series_family_soft_url,
    series_matrix_url,
    series_suppl_directory_url,
)
from app.tools.content_cache import ContentCache
from app.tools.workdir import create_task_workdir

FIXTURE_DIR = Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"


# --- provider id dispatcher -------------------------------------------------


def test_provider_ids_resolve() -> None:
    series = resolve_provider(GEO_SERIES_PROVIDER_ID)
    platform = resolve_provider(GEO_PLATFORM_PROVIDER_ID)
    assert series.provider_id == GEO_SERIES_PROVIDER_ID
    assert series.kind == "series"
    assert platform.provider_id == GEO_PLATFORM_PROVIDER_ID
    assert platform.kind == "platform"


def test_unknown_provider_id_rejected() -> None:
    with pytest.raises(ValueError, match="unknown GEO provider"):
        resolve_provider("geo.series.v99")


# --- accession validation ---------------------------------------------------


def test_accession_validation_normalizes_and_rejects() -> None:
    assert normalize_series_accession("gse15471") == "GSE15471"
    assert normalize_platform_accession("gpl570") == "GPL570"
    with pytest.raises(ValueError, match="series accession"):
        normalize_series_accession("SRR123")
    with pytest.raises(ValueError, match="platform accession"):
        normalize_platform_accession("GSE123")


# --- URL construction -------------------------------------------------------


def test_series_url_prefixes_match_ncbi_ftp_layout() -> None:
    assert series_dir_prefix("GSE15471") == "GSE15nnn"
    assert series_dir_prefix("GSE178352") == "GSE178nnn"
    assert series_counts_url("GSE15471") == (
        "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE15nnn/GSE15471/"
        "suppl/GSE15471_tximportCounts.txt.gz"
    )
    assert series_family_soft_url("GSE15471") == (
        "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE15nnn/GSE15471/"
        "soft/GSE15471_family.soft.gz"
    )
    assert series_matrix_url("GSE15471") == (
        "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE15nnn/GSE15471/"
        "matrix/GSE15471_series_matrix.txt.gz"
    )
    assert series_suppl_directory_url("GSE15471") == (
        "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE15nnn/GSE15471/suppl/"
    )


def test_platform_url_prefixes_match_ncbi_ftp_layout() -> None:
    assert platform_dir_prefix("GPL19072") == "GPL19nnn"
    assert platform_dir_prefix("GPL570") == "GPLnnn"
    assert platform_suppl_listing_url("GPL99999") == (
        "https://ftp.ncbi.nlm.nih.gov/geo/platforms/GPL99nnn/GPL99999/suppl/"
    )
    assert platform_annot_listing_url("GPL99999") == (
        "https://ftp.ncbi.nlm.nih.gov/geo/platforms/GPL99nnn/GPL99999/annot/"
    )
    assert platform_file_url("GPL99999", "suppl", "GPL99999_x.txt.gz") == (
        "https://ftp.ncbi.nlm.nih.gov/geo/platforms/GPL99nnn/GPL99999/"
        "suppl/GPL99999_x.txt.gz"
    )
    assert platform_landing_url("GPL99999") == (
        "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GPL99999"
    )


def test_platform_dir_prefix_delegates_to_single_rule(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The GPL-prefix rule has ONE implementation (review-loop R2b-02).

    ``platform_dir_prefix`` must be normalize + the shared rule
    (``geo_annotation.geo_platform_dir``) — if it re-implements the rule
    itself, the patch below does not propagate and this fails.
    """
    monkeypatch.setattr(
        "app.pipeline.processing.geo_provider.geo_platform_dir",
        lambda gpl: f"RULE-{gpl}",
    )
    assert platform_dir_prefix("GPL19072") == "RULE-GPL19072"
    assert platform_dir_prefix("gpl570") == "RULE-GPL570"


# --- fixture asset selection ------------------------------------------------


def _copy_fixture(tmp_path: Path) -> Path:
    fixture = tmp_path / "fixture"
    shutil.copytree(FIXTURE_DIR, fixture)
    return fixture


def test_fixture_series_asset_selection_finds_copy_directory_files(
    tmp_path: Path,
) -> None:
    fixture = _copy_fixture(tmp_path)
    selected = dict(select_series_fixture_assets(fixture, "GSE178352"))
    assert "tximport_counts" in selected
    assert "family_soft" in selected
    # The shared fixture ships no series matrix / supplementary expression.
    assert "series_matrix" not in selected
    assert "suppl_expression" not in selected


def test_fixture_platform_asset_selection(tmp_path: Path) -> None:
    fixture = tmp_path / "fixture"
    platform_dir = fixture / "platforms"
    platform_dir.mkdir(parents=True)
    asset = platform_dir / "gpl90001_annot.txt.gz"
    asset.write_bytes(b"platform annotation fixture bytes")
    assert select_platform_fixture_asset(fixture, "GPL90001") == asset
    assert select_platform_fixture_asset(fixture, "GPL90002") is None


# --- download attempts fail closed (checksum / size) -------------------------


def _source(url: str) -> SourceRecord:
    return SourceRecord(
        source_id="src_geo_provider_test",
        database=Database.GEO,
        accession="GSE999999",
        url=url,
        title="provider test asset",
        retrieved_at=datetime.now(UTC),
    )


def _series_url() -> str:
    return (
        "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE999nnn/GSE999999/"
        "suppl/GSE999999_tximportCounts.txt.gz"
    )


def _workdir(tmp_path: Path, task_id: str = "task_provider") -> object:
    return create_task_workdir(task_id, base_dir=str(tmp_path / "tasks"))


def test_series_download_checksum_mismatch_fails_closed(tmp_path: Path) -> None:
    payload = b"gene_id\tS1\nTP53\t1.5\n"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=payload)

    async def run() -> None:
        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        result = await acquire_series_asset(
            source=_source(_series_url()),
            filename="GSE999999_tximportCounts.txt.gz",
            workdir=_workdir(tmp_path),
            cache=ContentCache(tmp_path / "cache"),
            http=http,
            expected_sha256="0" * 64,
        )
        await http.aclose()
        assert result.asset is None
        assert result.attempt.status is DownloadStatus.FAILED
        assert "SHA-256" in (result.attempt.error_message or "")

    asyncio.run(run())


def test_series_download_size_limit_fails_closed(tmp_path: Path) -> None:
    payload = b"a" * 2048

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=payload)

    async def run() -> None:
        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        result = await acquire_series_asset(
            source=_source(_series_url()),
            filename="GSE999999_tximportCounts.txt.gz",
            workdir=_workdir(tmp_path),
            cache=ContentCache(tmp_path / "cache"),
            http=http,
            max_bytes=1024,
        )
        await http.aclose()
        assert result.asset is None
        assert result.attempt.status is DownloadStatus.FAILED
        assert "maximum" in (result.attempt.error_message or "")

    asyncio.run(run())


def test_series_download_expected_size_mismatch_fails_closed(
    tmp_path: Path,
) -> None:
    payload = b"gene_id\tS1\nTP53\t1.5\n"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=payload)

    async def run() -> None:
        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        result = await acquire_series_asset(
            source=_source(_series_url()),
            filename="GSE999999_tximportCounts.txt.gz",
            workdir=_workdir(tmp_path),
            cache=ContentCache(tmp_path / "cache"),
            http=http,
            expected_size=999_999,
        )
        await http.aclose()
        assert result.asset is None
        assert result.attempt.status is DownloadStatus.FAILED
        assert "size mismatch" in (result.attempt.error_message or "")

    asyncio.run(run())


def test_series_download_success_forms_source_asset(tmp_path: Path) -> None:
    payload = b"gene_id\tS1\nTP53\t1.5\n"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=payload)

    async def run() -> None:
        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        result = await acquire_series_asset(
            source=_source(_series_url()),
            filename="GSE999999_tximportCounts.txt.gz",
            workdir=_workdir(tmp_path),
            cache=ContentCache(tmp_path / "cache"),
            http=http,
        )
        await http.aclose()
        assert result.asset is not None
        assert result.asset.sha256 == hashlib.sha256(payload).hexdigest()
        assert result.asset.size_bytes == len(payload)
        assert result.attempt.status is DownloadStatus.SUCCEEDED

    asyncio.run(run())


# --- V1 fixture regression (provider refactor keeps the GEO flow unchanged) --


def test_fixture_geo_acquisition_and_processing_unchanged(tmp_path: Path) -> None:
    """The V1 fixture GEO flow (acquisition → processing) must produce the
    same shapes after the acquisition provider refactor: one tximport counts
    asset with a matching download attempt, and a parsed dataset with real
    expression rows."""
    from app.pipeline.stages import acquisition
    from app.pipeline.stages.base import StageContext
    from app.pipeline.stages.processing import run_processing

    fixture = _copy_fixture(tmp_path)
    ctx = StageContext(
        task_id="task_geo_fixture_reg",
        workdir=_workdir(tmp_path, "task_geo_fixture_reg"),
        fixture_dir=fixture,
        topic="fixture regression",
        started_at=datetime.now(UTC),
        mode="fixture",
        databases=["geo"],
    )
    acquired = acquisition.run_acquisition(ctx, datetime.now(UTC))
    assert len(acquired.output.source_assets) == 1
    asset = acquired.output.source_assets[0]
    assert "tximportCounts" in asset.relative_path
    assert len(acquired.output.download_attempts) == 1
    assert acquired.output.download_attempts[0].status is DownloadStatus.SUCCEEDED

    processed = run_processing(ctx, acquired.output.source_assets, "ds_geo_gse178352")
    assert len(processed.output.parsed_datasets) == 1
    assert processed.output.parsed_datasets[0].row_count > 0
    assert processed.output.samples  # sample metadata recovered from SOFT
