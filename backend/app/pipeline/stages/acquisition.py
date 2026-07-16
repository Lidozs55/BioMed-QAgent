"""Acquisition stage: fixture gzip or live download of GEO counts."""
from __future__ import annotations

import asyncio
import gzip
import hashlib
import os
from datetime import datetime

import httpx

from app.domain.contracts import (
    Database,
    DataLevel,
    DownloadAttempt,
    DownloadStatus,
    SourceAsset,
    SourceRecord,
    asset_id_from_sha256,
    make_source_id,
)
from app.integrations.acquisition import acquire_source
from app.pipeline.stages.base import (
    AcquisitionOutput,
    StageContext,
    StageResult,
)
from app.tools.content_cache import ContentCache

_GSE = "GSE178352"
_DOWNLOAD_URL = (
    "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE178nnn/"
    "GSE178352/suppl/GSE178352_tximportCounts.txt.gz"
)
_MAX_BYTES = 100 * 1024 * 1024  # 100 MB safety cap


def run_acquisition(ctx: StageContext, retrieved_at: datetime) -> StageResult:
    """Download (live) or gzip (fixture) the GEO counts and publish as SourceAsset.

    In fixture mode, reads ``tximport_counts_slice.tsv`` from the fixture,
    compresses it with ``mtime=0`` for reproducibility, and writes to
    ``source_assets/``.

    In live mode, streams the real ``GSE178352_tximportCounts.txt.gz`` from
    NCBI FTP via ``acquire_source``, with content-addressed caching.
    """
    if ctx.mode == "live":
        return _run_acquisition_live(ctx, retrieved_at)
    return _run_acquisition_fixture(ctx, retrieved_at)


def _run_acquisition_fixture(
    ctx: StageContext, retrieved_at: datetime
) -> StageResult:
    compressed = gzip.compress(
        (ctx.fixture_dir / "tximport_counts_slice.tsv").read_bytes(), mtime=0
    )
    checksum = hashlib.sha256(compressed).hexdigest()
    source_path = ctx.workdir.source_assets / "GSE178352_tximportCounts.fixture.txt.gz"
    if source_path.exists():
        if hashlib.sha256(source_path.read_bytes()).hexdigest() != checksum:
            raise FileExistsError(
                "fixture source asset already exists with different content"
            )
    else:
        with source_path.open("xb") as handle:
            handle.write(compressed)
            handle.flush()
            os.fsync(handle.fileno())

    attempt_id = "download_attempt_fixture_gse178352"
    source_asset = SourceAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="source",
        relative_path=source_path.relative_to(ctx.workdir.root).as_posix(),
        sha256=checksum,
        size_bytes=len(compressed),
        media_type="application/gzip",
        source_id=_geo_source_id(ctx),
        successful_attempt_id=attempt_id,
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )
    download_attempt = DownloadAttempt(
        attempt_id=attempt_id,
        source_id=source_asset.source_id,
        url=_fixture_url(ctx),
        status=DownloadStatus.SUCCEEDED,
        bytes_received=len(compressed),
        started_at=retrieved_at,
        finished_at=retrieved_at,
    )

    output = AcquisitionOutput(
        source_assets=[source_asset],
        download_attempts=[download_attempt],
        source_path=source_path,
        retrieved_at=retrieved_at,
    )
    return StageResult(output_digest=checksum, output=output)


def _run_acquisition_live(
    ctx: StageContext, retrieved_at: datetime
) -> StageResult:
    """Download the real GSE178352 counts file from NCBI FTP."""

    async def _download() -> StageResult:
        geo_url = f"https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc={_GSE}"
        source = SourceRecord(
            source_id=make_source_id(Database.GEO, _GSE, geo_url),
            database=Database.GEO,
            accession=_GSE,
            url=_DOWNLOAD_URL,
            title=f"{_GSE} tximport counts",
            retrieved_at=retrieved_at,
        )
        cache = ContentCache(ctx.workdir.root.parent.parent / "cache" / "ncbi")
        async with httpx.AsyncClient() as http:
            result = await acquire_source(
                source=source,
                filename="GSE178352_tximportCounts.txt.gz",
                workdir=ctx.workdir,
                cache=cache,
                http=http,
                data_level=DataLevel.REPOSITORY_PROCESSED,
                max_bytes=_MAX_BYTES,
            )
        if result.asset is None:
            raise RuntimeError(
                f"live download failed: {result.attempt.error_message}"
            )
        output = AcquisitionOutput(
            source_assets=[result.asset],
            download_attempts=[result.attempt],
            source_path=ctx.workdir.root / result.asset.relative_path,
            retrieved_at=retrieved_at,
        )
        digest = result.asset.sha256
        return StageResult(output_digest=digest, output=output)

    return asyncio.run(_download())


def _geo_source_id(ctx: StageContext) -> str:
    geo_url = f"https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc={_GSE}"
    return make_source_id(Database.GEO, _GSE, geo_url)


def _fixture_url(ctx: StageContext) -> str:
    """Return the fixture's recorded source URL for the download log."""
    import json

    fixture_manifest = json.loads((ctx.fixture_dir / "manifest.json").read_text("utf-8"))
    return fixture_manifest["sources"]["tximport_counts"]["url"]
