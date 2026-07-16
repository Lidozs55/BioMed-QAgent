"""Acquisition stage: gzip fixture counts and create SourceAsset + DownloadAttempt."""
from __future__ import annotations

import gzip
import hashlib
import os
from datetime import datetime

from app.domain.contracts import (
    DataLevel,
    DownloadAttempt,
    DownloadStatus,
    SourceAsset,
    asset_id_from_sha256,
)
from app.pipeline.stages.base import (
    AcquisitionOutput,
    StageContext,
    StageResult,
)


def run_acquisition(ctx: StageContext, retrieved_at: datetime) -> StageResult:
    """Gzip the fixture tximport slice and publish it as a SourceAsset.

    Reads ``tximport_counts_slice.tsv`` from the fixture, compresses it with
    ``mtime=0`` for reproducibility, writes to ``source_assets/`` and records
    a successful DownloadAttempt.
    """
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
        source_id=_geo_source_id_from_ctx(ctx),
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


def _geo_source_id_from_ctx(ctx: StageContext) -> str:
    """Derive the GEO source_id from the fixture manifest (mirrors discovery)."""
    from app.domain.contracts import Database, make_source_id

    geo_accession = "GSE178352"
    geo_url = f"https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc={geo_accession}"
    return make_source_id(Database.GEO, geo_accession, geo_url)


def _fixture_url(ctx: StageContext) -> str:
    """Return the fixture's recorded source URL for the download log."""
    import json

    fixture_manifest = json.loads((ctx.fixture_dir / "manifest.json").read_text("utf-8"))
    return fixture_manifest["sources"]["tximport_counts"]["url"]
