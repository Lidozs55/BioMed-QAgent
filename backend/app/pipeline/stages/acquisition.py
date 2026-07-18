"""Acquisition stage: fixture gzip or live download of GEO counts."""
from __future__ import annotations

import asyncio
import gzip
import hashlib
import os
import re
from datetime import datetime

import httpx

from app.domain.contracts import (
    Database,
    DataLevel,
    DatasetSelection,
    DownloadAttempt,
    DownloadStatus,
    SourceAsset,
    SourceRecord,
    StageName,
    TaskSpecification,
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

_DEFAULT_GSE = "GSE178352"
_MAX_BYTES = 100 * 1024 * 1024  # 100 MB safety cap


def _extract_gse_accession(value: str) -> str | None:
    match = re.search(r"(GSE\d+)(?:\[Accession\])?", value, re.IGNORECASE)
    return match.group(1).upper() if match else None


def _resolve_geo_dataset(ctx: StageContext) -> DatasetSelection:
    """Return the GEO dataset selected by the specification."""
    specification = ctx.specification
    if specification is None:
        specification = _default_specification(ctx)
    for dataset in specification.datasets:
        if dataset.database == Database.GEO:
            return dataset
    # Fallback to the pinned Phase 1 case.
    return _default_specification(ctx).datasets[0]


def _default_specification(ctx: StageContext) -> TaskSpecification:
    from app.domain.contracts import QuerySpecification, RequestedOutput

    return TaskSpecification(
        topic=ctx.topic,
        queries=[
            QuerySpecification(
                query_id="query_geo_1",
                database=Database.GEO,
                query=f"{_DEFAULT_GSE}[Accession]",
                generated_by="pipeline",
                purpose="pinned dataset",
                order=1,
            )
        ],
        datasets=[
            DatasetSelection(
                dataset_id=f"ds_geo_{_DEFAULT_GSE.lower()}",
                database=Database.GEO,
                accession=_DEFAULT_GSE,
                source_id="",
                reason="pinned dataset",
            )
        ],
        requested_outputs=[
            RequestedOutput.MAIN_DATA,
            RequestedOutput.LITERATURE,
            RequestedOutput.DATASET_CATALOG,
            RequestedOutput.SAMPLE_METADATA,
        ],
    )


def _counts_download_url(gse: str) -> str:
    """Build the NCBI GEO supplemental counts URL for a GSE accession."""
    prefix = gse[:6].upper()
    return (
        f"https://ftp.ncbi.nlm.nih.gov/geo/series/{prefix}nnn/"
        f"{gse}/suppl/{gse}_tximportCounts.txt.gz"
    )


def run_acquisition(ctx: StageContext, retrieved_at: datetime) -> StageResult:
    """Download (live) or gzip (fixture) the GEO counts and publish as SourceAsset.

    In fixture mode, reads ``tximport_counts_slice.tsv`` from the fixture,
    compresses it with ``mtime=0`` for reproducibility, and writes to
    ``source_assets/``.

    In live mode, streams the real GEO counts file from NCBI FTP via
    ``acquire_source``, with content-addressed caching.
    """
    dataset = _resolve_geo_dataset(ctx)
    gse = _extract_gse_accession(dataset.accession) or _DEFAULT_GSE
    if ctx.mode == "live":
        return _run_acquisition_live(ctx, retrieved_at, gse)
    return _run_acquisition_fixture(ctx, retrieved_at, gse)


def _run_acquisition_fixture(
    ctx: StageContext, retrieved_at: datetime, gse: str
) -> StageResult:
    if gse.upper() != _DEFAULT_GSE:
        raise ValueError(
            f"fixture mode only supports the pinned dataset {_DEFAULT_GSE}, got {gse}"
        )
    compressed = gzip.compress(
        (ctx.fixture_dir / "tximport_counts_slice.tsv").read_bytes(), mtime=0
    )
    checksum = hashlib.sha256(compressed).hexdigest()
    source_path = ctx.workdir.source_assets / f"{gse}_tximportCounts.fixture.txt.gz"
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

    attempt_id = f"download_attempt_fixture_{gse.lower()}"
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

    # Surface acquisition progress: "Acquisition: downloaded N bytes (1 asset)".
    # See docs/REVIEW_2026-07-18.md §4.
    ctx.emit_progress_sync(
        stage=StageName.ACQUISITION,
        kind="downloaded_bytes",
        current=len(compressed),
        total=None,
        detail={
            "source": "geo",
            "accession": gse,
            "filename": source_path.name,
            "records": 1,
        },
    )

    output = AcquisitionOutput(
        source_assets=[source_asset],
        download_attempts=[download_attempt],
        source_path=source_path,
        retrieved_at=retrieved_at,
    )
    return StageResult(output_digest=checksum, output=output)


def _run_acquisition_live(
    ctx: StageContext, retrieved_at: datetime, gse: str
) -> StageResult:
    """Download the real GEO counts file for ``gse`` from NCBI FTP."""
    download_url = _counts_download_url(gse)

    async def _download() -> StageResult:
        geo_url = f"https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc={gse}"
        source = SourceRecord(
            source_id=make_source_id(Database.GEO, gse, geo_url),
            database=Database.GEO,
            accession=gse,
            url=download_url,
            title=f"{gse} tximport counts",
            retrieved_at=retrieved_at,
        )
        cache = ContentCache(ctx.workdir.root.parent.parent / "cache" / "ncbi")
        async with httpx.AsyncClient() as http:
            result = await acquire_source(
                source=source,
                filename=f"{gse}_tximportCounts.txt.gz",
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
        # Surface live acquisition progress. See docs/REVIEW_2026-07-18.md §4.
        ctx.emit_progress_sync(
            stage=StageName.ACQUISITION,
            kind="downloaded_bytes",
            current=result.asset.size_bytes,
            total=None,
            detail={
                "source": "geo",
                "accession": gse,
                "filename": f"{gse}_tximportCounts.txt.gz",
                "records": 1,
            },
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
    dataset = _resolve_geo_dataset(ctx)
    gse = _extract_gse_accession(dataset.accession) or _DEFAULT_GSE
    geo_url = f"https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc={gse}"
    return make_source_id(Database.GEO, gse, geo_url)


def _fixture_url(ctx: StageContext) -> str:
    """Return the fixture's recorded source URL for the download log."""
    import json

    fixture_manifest = json.loads((ctx.fixture_dir / "manifest.json").read_text("utf-8"))
    return fixture_manifest["sources"]["tximport_counts"]["url"]
