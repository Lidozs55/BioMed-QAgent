"""Acquisition stage: fixture gzip or live download of GEO counts."""

from __future__ import annotations

import asyncio
import contextlib
import gzip
import hashlib
import json
import logging
import os
import re
from datetime import UTC, datetime
from pathlib import Path

import httpx

from app.domain.contracts import (
    Database,
    DataLevel,
    DatasetSelection,
    DownloadAttempt,
    DownloadStatus,
    ErrorCode,
    SourceAsset,
    SourceRecord,
    StageName,
    TaskSpecification,
    asset_id_from_sha256,
    generate_prefixed_uuid,
    make_source_id,
)
from app.integrations.acquisition import AcquisitionResult, acquire_source
from app.pipeline.stages.base import (
    AcquisitionOutput,
    StageContext,
    StageResult,
)
from app.tools.content_cache import ContentCache, canonical_request_hash

_DEFAULT_GSE = "GSE178352"
_MAX_BYTES = 100 * 1024 * 1024  # 100 MB safety cap

logger = logging.getLogger(__name__)


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


def _family_soft_url(gse: str) -> str:
    prefix = gse[:6].upper()
    return f"https://ftp.ncbi.nlm.nih.gov/geo/series/{prefix}nnn/{gse}/soft/{gse}_family.soft.gz"


def _series_matrix_url(gse: str) -> str:
    """Build the NCBI GEO series matrix URL (universally available fallback)."""
    prefix = gse[:6].upper()
    return (
        f"https://ftp.ncbi.nlm.nih.gov/geo/series/{prefix}nnn/"
        f"{gse}/matrix/{gse}_series_matrix.txt.gz"
    )


async def _try_acquire(
    source: SourceRecord,
    filename: str,
    ctx: StageContext,
    cache: ContentCache,
    http: httpx.AsyncClient,
    gse: str,
) -> AcquisitionResult:
    """Attempt acquire_source and never discard the attempt record.

    A failed download returns an ``AcquisitionResult`` whose ``attempt`` is
    FAILED and ``asset`` is None (instead of ``None``), so callers can
    publish the complete fallback chain in ``download_log.csv`` (§1.5.2).
    """
    try:
        return await acquire_source(
            source=source,
            filename=filename,
            workdir=ctx.workdir,
            cache=cache,
            http=http,
            data_level=DataLevel.REPOSITORY_PROCESSED,
            max_bytes=_MAX_BYTES,
        )
    except Exception as exc:  # noqa: BLE001 — log and fall back
        logger.warning("acquisition: download failed for %s: %s", source.url, exc)
        attempt_id = generate_prefixed_uuid("download_attempt")
        started_at = datetime.now(UTC)
        return AcquisitionResult(
            attempt=DownloadAttempt(
                attempt_id=attempt_id,
                source_id=source.source_id,
                url=source.url,
                status=DownloadStatus.FAILED,
                bytes_received=0,
                error_code=ErrorCode.NETWORK_ERROR,
                error_message=str(exc),
                started_at=started_at,
                finished_at=datetime.now(UTC),
            ),
            asset=None,
        )


def run_acquisition(ctx: StageContext, retrieved_at: datetime) -> StageResult:
    """Download (live) or fixture data and publish as SourceAsset.

    GDC uses its files API to select one deterministic file for the explicit
    project and data type, then downloads it through acquire_source().

    In fixture mode, reads the fixture table and writes to source_assets.
    In live mode, streams the source through acquire_source with caching.
    """
    specification = ctx.specification
    data_datasets = [
        dataset
        for dataset in (specification.datasets if specification else [])
        if dataset.database in {Database.GDC, Database.UCSC_XENA}
    ]
    if len(data_datasets) > 1:
        return _run_gdc_xena_acquisition(ctx, retrieved_at, data_datasets)
    gdc_dataset = next(
        (
            d
            for d in (specification.datasets if specification else [])
            if d.database == Database.GDC
        ),
        None,
    )
    if gdc_dataset is not None:
        if ctx.mode == "fixture":
            return _run_gdc_acquisition_fixture(ctx, retrieved_at, gdc_dataset)
        return asyncio.run(_run_gdc_acquisition_live(ctx, retrieved_at, gdc_dataset))

    if specification and any(
        dataset.database == Database.UCSC_XENA for dataset in specification.datasets
    ):
        dataset = next(
            dataset for dataset in specification.datasets if dataset.database == Database.UCSC_XENA
        )
        if ctx.mode == "live":
            return asyncio.run(_run_xena_acquisition_live(ctx, retrieved_at, dataset))
        return _run_xena_acquisition_fixture(ctx, retrieved_at, dataset)
    reactome_dataset = next(
        (
            dataset
            for dataset in (specification.datasets if specification else [])
            if dataset.database == Database.REACTOME
        ),
        None,
    )
    if reactome_dataset is not None:
        if ctx.mode == "live":
            return asyncio.run(_run_reactome_acquisition_live(ctx, retrieved_at, reactome_dataset))
        return _run_reactome_acquisition_fixture(ctx, retrieved_at, reactome_dataset)

    dataset = _resolve_geo_dataset(ctx)
    gse = _extract_gse_accession(dataset.accession) or _DEFAULT_GSE
    if ctx.mode == "live":
        return _run_acquisition_live(ctx, retrieved_at, gse)
    return _run_acquisition_fixture(ctx, retrieved_at, gse)


def _gdc_fixture_file(ctx: StageContext, data_type: str) -> Path:
    name = "gdc_expression.tsv" if data_type.startswith("gene") else "gdc_clinical.tsv"
    path = ctx.fixture_dir / name
    if not path.is_file():
        raise FileNotFoundError(path)
    return path


def _run_gdc_acquisition_fixture(
    ctx: StageContext, retrieved_at: datetime, dataset: DatasetSelection
) -> StageResult:
    payload = _gdc_fixture_file(ctx, dataset.data_type or "").read_bytes()
    checksum = hashlib.sha256(payload).hexdigest()
    source_id = dataset.source_id or make_source_id(
        Database.GDC, dataset.accession, f"https://api.gdc.cancer.gov/projects/{dataset.accession}"
    )
    path = ctx.workdir.source_assets / _gdc_fixture_file(ctx, dataset.data_type or "").name
    path.write_bytes(payload)
    attempt_id = f"download_attempt_fixture_gdc_{dataset.accession.lower()}"
    asset = SourceAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="source",
        relative_path=path.relative_to(ctx.workdir.root).as_posix(),
        sha256=checksum,
        size_bytes=len(payload),
        media_type="application/gzip" if path.suffix == ".gz" else "text/tab-separated-values",
        source_id=source_id,
        successful_attempt_id=attempt_id,
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )
    attempt = DownloadAttempt(
        attempt_id=attempt_id,
        source_id=source_id,
        url=f"https://api.gdc.cancer.gov/data/{dataset.accession}",
        status=DownloadStatus.SUCCEEDED,
        bytes_received=len(payload),
        started_at=retrieved_at,
        finished_at=retrieved_at,
    )
    return StageResult(
        output_digest=checksum,
        output=AcquisitionOutput(
            source_assets=[asset],
            download_attempts=[attempt],
            source_path=path,
            retrieved_at=retrieved_at,
        ),
    )


async def _run_gdc_acquisition_live(
    ctx: StageContext, retrieved_at: datetime, dataset: DatasetSelection
) -> StageResult:
    if not dataset.data_type:
        raise ValueError("GDC acquisition requires data_type")
    official_data_type = _gdc_live_data_type(dataset.data_type)
    params = {
        "filters": json.dumps(
            {
                "op": "and",
                "content": [
                    {
                        "op": "=",
                        "content": {
                            "field": "cases.project.project_id",
                            "value": dataset.accession,
                        },
                    },
                    {
                        "op": "=",
                        "content": {"field": "data_type", "value": official_data_type},
                    },
                    {
                        "op": "=",
                        "content": {"field": "data_format", "value": "TSV"},
                    },
                ],
            }
        ),
        "fields": "file_id,file_name,md5sum,data_format",
        "format": "json",
        "size": "10",
    }
    async with httpx.AsyncClient() as http:
        response = await http.get("https://api.gdc.cancer.gov/files", params=params, timeout=30)
        response.raise_for_status()
        hits = response.json().get("data", {}).get("hits", [])
        if not hits:
            raise ValueError(f"no GDC file for {dataset.accession}/{dataset.data_type}")
        hit = sorted(hits, key=lambda item: (item.get("file_name", ""), item.get("file_id", "")))[0]
        file_id = hit.get("file_id")
        filename = hit.get("file_name")
        if (
            not file_id
            or not filename
            or hit.get("data_format") not in {"TSV", "tsv", "TSV.GZ", "tsv.gz"}
        ):
            raise ValueError("GDC file metadata lacks supported id/name/data_format")
        url = f"https://api.gdc.cancer.gov/data/{file_id}"
        source = SourceRecord(
            source_id=dataset.source_id or make_source_id(Database.GDC, dataset.accession, url),
            database=Database.GDC,
            accession=dataset.accession,
            url=url,
            title=filename,
            retrieved_at=retrieved_at,
        )
        result = await acquire_source(
            source=source,
            filename=filename,
            workdir=ctx.workdir,
            cache=ContentCache(ctx.workdir.root.parent.parent / "cache" / "gdc"),
            http=http,
            data_level=DataLevel.REPOSITORY_PROCESSED,
            max_bytes=_MAX_BYTES,
            expected_sha256=hit.get("md5sum") if len(hit.get("md5sum", "")) == 64 else None,
        )
    if result.asset is None:
        raise RuntimeError(f"GDC download failed: {result.attempt.error_message}")
    return StageResult(
        output_digest=result.asset.sha256,
        output=AcquisitionOutput(
            source_assets=[result.asset],
            download_attempts=[result.attempt],
            source_path=ctx.workdir.root / result.asset.relative_path,
            retrieved_at=retrieved_at,
        ),
    )


def _gdc_live_data_type(data_type: str) -> str:
    normalized = data_type.strip().lower().replace("_", "-")
    if normalized in {
        "gene-expression",
        "gene expression",
        "expression",
        "gene expression quantification",
    }:
        return "Gene Expression Quantification"
    if normalized == "clinical":
        raise ValueError(
            "GDC live clinical is not supported: Clinical Supplement files require "
            "an XML lineage parser"
        )
    raise ValueError(f"unsupported GDC live data type: {data_type}")


async def _run_xena_acquisition_live(
    ctx: StageContext, retrieved_at: datetime, dataset: DatasetSelection
) -> StageResult:
    url = (
        "https://toil-xena-hub.s3.us-east-1.amazonaws.com/download/"
        f"{dataset.accession.removesuffix('.gz')}.gz"
    )
    identity_url = f"https://xenabrowser.net/datapages/?dataset={dataset.accession}"
    source = SourceRecord(
        source_id=dataset.source_id
        or make_source_id(Database.UCSC_XENA, dataset.accession, identity_url),
        database=Database.UCSC_XENA,
        accession=dataset.accession,
        url=url,
        title=f"UCSC Xena dataset {dataset.accession}",
        retrieved_at=retrieved_at,
    )
    cache = ContentCache(ctx.workdir.root.parent.parent / "cache" / "xena")
    filename = dataset.accession.replace("/", "_") + ".gz"
    async with httpx.AsyncClient() as http:
        result = await _try_acquire(source, filename, ctx, cache, http, dataset.accession)
    if result.asset is None:
        raise RuntimeError(f"live Xena download failed for {dataset.accession}")
    ctx.emit_progress_sync(
        stage=StageName.ACQUISITION,
        kind="downloaded_bytes",
        current=result.asset.size_bytes,
        total=None,
        detail={
            "source": "ucsc_xena",
            "dataset_id": dataset.accession,
            "filename": filename,
            "records": 1,
        },
    )
    return StageResult(
        output_digest=result.asset.sha256,
        output=AcquisitionOutput(
            source_assets=[result.asset],
            download_attempts=[result.attempt],
            source_path=ctx.workdir.root / result.asset.relative_path,
            retrieved_at=retrieved_at,
        ),
    )


def _validate_reactome_content_service_json(path: Path) -> None:
    try:
        payload = json.loads(path.read_text("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("Reactome ContentService response is not valid JSON") from exc
    if not isinstance(payload, list) or not payload:
        raise ValueError("Reactome ContentService response must be a non-empty JSON list")
    for index, item in enumerate(payload):
        if not isinstance(item, dict):
            raise ValueError(f"Reactome participant at index {index} is not an object")
        participant_id = item.get("stId") or item.get("databaseName") or item.get("dbId")
        if not isinstance(participant_id, (str, int)) or not str(participant_id).strip():
            raise ValueError(
                f"Reactome participant at index {index} is missing a participant identifier"
            )


def _normalize_reactome_json_asset(
    ctx: StageContext,
    dataset: DatasetSelection,
    json_asset: SourceAsset,
    attempt: DownloadAttempt,
) -> SourceAsset:
    """Convert validated ContentService JSON into the TSV consumed by Validation."""
    from app.pipeline.processing.reactome import _open_reactome_json

    json_path = ctx.workdir.root / json_asset.relative_path
    normalized_path = ctx.workdir.source_assets / f"{dataset.accession}_participants.normalized.tsv"
    with _open_reactome_json(json_path, dataset.accession) as source, normalized_path.open(
        "w", encoding="utf-8", newline=""
    ) as target:
        target.write(source.read())
    payload = normalized_path.read_bytes()
    checksum = hashlib.sha256(payload).hexdigest()
    return SourceAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="source",
        relative_path=normalized_path.relative_to(ctx.workdir.root).as_posix(),
        sha256=checksum,
        size_bytes=len(payload),
        media_type="text/tab-separated-values",
        source_id=json_asset.source_id,
        successful_attempt_id=attempt.attempt_id,
        data_level=json_asset.data_level,
    )


async def _run_reactome_acquisition_live(
    ctx: StageContext, retrieved_at: datetime, dataset: DatasetSelection
) -> StageResult:
    if not dataset.accession or dataset.data_type != "pathway-participants":
        raise ValueError(
            "Reactome acquisition requires pathway_id and pathway-participants data_type"
        )
    url = f"https://reactome.org/ContentService/data/participants/{dataset.accession}"
    source = SourceRecord(
        source_id=dataset.source_id or make_source_id(Database.REACTOME, dataset.accession, url),
        database=Database.REACTOME,
        accession=dataset.accession,
        url=url,
        title=f"Reactome {dataset.accession} participants",
        retrieved_at=retrieved_at,
    )
    cache = ContentCache(ctx.workdir.root.parent.parent / "cache" / "reactome")
    async with httpx.AsyncClient() as http:
        result = await acquire_source(
            source=source,
            filename=f"{dataset.accession}_participants.json",
            workdir=ctx.workdir,
            cache=cache,
            http=http,
            data_level=DataLevel.REPOSITORY_PROCESSED,
            max_bytes=_MAX_BYTES,
            expected_media_types=frozenset({"application/json"}),
            accept="application/json",
        )
    if result.asset is None:
        raise RuntimeError(f"live Reactome download failed for {dataset.accession}")
    source_path = ctx.workdir.root / result.asset.relative_path
    try:
        _validate_reactome_content_service_json(source_path)
        normalized_asset = _normalize_reactome_json_asset(
            ctx, dataset, result.asset, result.attempt
        )
    except ValueError as exc:
        source_path.unlink(missing_ok=True)
        with contextlib.suppress(OSError):
            source_path.parent.rmdir()
        request_hash = canonical_request_hash(
            source.database.value, source.accession, source.url
        )
        cached = cache.read_metadata(request_hash)
        if cached is not None and cached.get("sha256") == result.asset.sha256:
            with contextlib.suppress(OSError):
                cache.metadata_path(request_hash).unlink()
                cache.blob_path(result.asset.sha256).unlink()
        raise RuntimeError(f"live Reactome download failed for {dataset.accession}: {exc}") from exc
    return StageResult(
        output_digest=normalized_asset.sha256,
        output=AcquisitionOutput(
            source_assets=[result.asset, normalized_asset],
            download_attempts=[result.attempt],
            source_path=ctx.workdir.root / normalized_asset.relative_path,
            retrieved_at=retrieved_at,
        ),
    )


def _run_reactome_acquisition_fixture(
    ctx: StageContext, retrieved_at: datetime, dataset: DatasetSelection
) -> StageResult:
    if not dataset.accession or dataset.data_type != "pathway-participants":
        raise ValueError(
            "Reactome acquisition requires pathway_id and pathway-participants data_type"
        )
    payload = (ctx.fixture_dir / "pathway_participants.tsv").read_bytes()
    checksum = hashlib.sha256(payload).hexdigest()
    source_path = ctx.workdir.source_assets / f"{dataset.accession}_participants.fixture.tsv"
    source_path.write_bytes(payload)
    url = f"https://reactome.org/ContentService/data/participants/{dataset.accession}"
    source_id = dataset.source_id or make_source_id(Database.REACTOME, dataset.accession, url)
    attempt_id = f"download_attempt_fixture_reactome_{dataset.accession.lower()}"
    asset = SourceAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="source",
        relative_path=source_path.relative_to(ctx.workdir.root).as_posix(),
        sha256=checksum,
        size_bytes=len(payload),
        media_type="text/tab-separated-values",
        source_id=source_id,
        successful_attempt_id=attempt_id,
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )
    attempt = DownloadAttempt(
        attempt_id=attempt_id,
        source_id=source_id,
        url=url,
        status=DownloadStatus.SUCCEEDED,
        bytes_received=len(payload),
        started_at=retrieved_at,
        finished_at=retrieved_at,
    )
    return StageResult(
        output_digest=checksum,
        output=AcquisitionOutput(
            source_assets=[asset],
            download_attempts=[attempt],
            source_path=source_path,
            retrieved_at=retrieved_at,
        ),
    )


def _run_xena_acquisition_fixture(
    ctx: StageContext, retrieved_at: datetime, dataset: DatasetSelection
) -> StageResult:
    payload = (ctx.fixture_dir / "xena_matrix.tsv").read_bytes()
    checksum = hashlib.sha256(payload).hexdigest()
    source_path = ctx.workdir.source_assets / "xena_matrix.fixture.tsv"
    if source_path.exists() and hashlib.sha256(source_path.read_bytes()).hexdigest() != checksum:
        raise FileExistsError("fixture Xena source asset already exists with different content")
    if not source_path.exists():
        source_path.write_bytes(payload)
    url = f"https://xenabrowser.net/datapages/?dataset={dataset.accession}"
    source_id = dataset.source_id or make_source_id(Database.UCSC_XENA, dataset.accession, url)
    attempt_id = f"download_attempt_fixture_xena_{dataset.accession.lower()}"
    asset = SourceAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="source",
        relative_path=source_path.relative_to(ctx.workdir.root).as_posix(),
        sha256=checksum,
        size_bytes=len(payload),
        media_type="text/tab-separated-values",
        source_id=source_id,
        successful_attempt_id=attempt_id,
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )
    attempt = DownloadAttempt(
        attempt_id=attempt_id,
        source_id=source_id,
        url=url,
        status=DownloadStatus.SUCCEEDED,
        bytes_received=len(payload),
        started_at=retrieved_at,
        finished_at=retrieved_at,
    )
    return StageResult(
        output_digest=checksum,
        output=AcquisitionOutput(
            source_assets=[asset],
            download_attempts=[attempt],
            source_path=source_path,
            retrieved_at=retrieved_at,
        ),
    )


def _run_gdc_xena_acquisition(
    ctx: StageContext,
    retrieved_at: datetime,
    datasets: list[DatasetSelection],
) -> StageResult:
    databases = {dataset.database for dataset in datasets}
    if len(datasets) != 2 or databases != {Database.GDC, Database.UCSC_XENA}:
        raise ValueError("multi-source acquisition supports exactly one GDC and one Xena dataset")
    if ctx.specification is None or len(ctx.specification.datasets) != 2:
        raise ValueError("GDC + Xena acquisition cannot be combined with other datasets")
    if ctx.mode == "live":
        results = asyncio.run(_run_gdc_xena_acquisition_live(ctx, retrieved_at, datasets))
    else:
        results = [
            _run_gdc_acquisition_fixture(ctx, retrieved_at, dataset)
            if dataset.database == Database.GDC
            else _run_xena_acquisition_fixture(ctx, retrieved_at, dataset)
            for dataset in datasets
        ]
    assets = [asset for result in results for asset in result.output.source_assets]
    attempts = [attempt for result in results for attempt in result.output.download_attempts]
    digest = hashlib.sha256(
        json.dumps([asset.sha256 for asset in assets], separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return StageResult(
        output_digest=digest,
        output=AcquisitionOutput(
            source_assets=assets,
            download_attempts=attempts,
            source_path=ctx.workdir.root / assets[0].relative_path,
            retrieved_at=retrieved_at,
        ),
    )


async def _run_gdc_xena_acquisition_live(
    ctx: StageContext,
    retrieved_at: datetime,
    datasets: list[DatasetSelection],
) -> list[StageResult]:
    results: list[StageResult] = []
    for dataset in datasets:
        if dataset.database == Database.GDC:
            results.append(await _run_gdc_acquisition_live(ctx, retrieved_at, dataset))
        else:
            results.append(await _run_xena_acquisition_live(ctx, retrieved_at, dataset))
    return results


def _run_acquisition_fixture(ctx: StageContext, retrieved_at: datetime, gse: str) -> StageResult:
    if gse.upper() != _DEFAULT_GSE:
        raise ValueError(f"fixture mode only supports the pinned dataset {_DEFAULT_GSE}, got {gse}")
    compressed = gzip.compress(
        (ctx.fixture_dir / "tximport_counts_slice.tsv").read_bytes(), mtime=0
    )
    checksum = hashlib.sha256(compressed).hexdigest()
    source_path = ctx.workdir.source_assets / f"{gse}_tximportCounts.fixture.txt.gz"
    if source_path.exists():
        if hashlib.sha256(source_path.read_bytes()).hexdigest() != checksum:
            raise FileExistsError("fixture source asset already exists with different content")
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


def _run_acquisition_live(ctx: StageContext, retrieved_at: datetime, gse: str) -> StageResult:
    """Download the real GEO counts file for ``gse`` from NCBI FTP.

    Tries the tximport counts URL first; if that 404s (many GEO series don't
    ship tximport counts), falls back to the universally-available series
    matrix file. The processing stage handles both formats.
    """

    async def _download() -> StageResult:
        geo_url = f"https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc={gse}"
        source_id = make_source_id(Database.GEO, gse, geo_url)
        cache = ContentCache(ctx.workdir.root.parent.parent / "cache" / "ncbi")

        candidates: list[tuple[str, str, str]] = [
            (_counts_download_url(gse), f"{gse}_tximportCounts.txt.gz", f"{gse} tximport counts"),
            (_series_matrix_url(gse), f"{gse}_series_matrix.txt.gz", f"{gse} series matrix"),
        ]

        async with httpx.AsyncClient() as http:
            result: AcquisitionResult | None = None
            attempts: list[DownloadAttempt] = []
            used_filename = ""
            for download_url, filename, title in candidates:
                logger.info("acquisition: trying %s", download_url)
                source = SourceRecord(
                    source_id=source_id,
                    database=Database.GEO,
                    accession=gse,
                    url=download_url,
                    title=title,
                    retrieved_at=retrieved_at,
                )
                result = await _try_acquire(source, filename, ctx, cache, http, gse)
                attempts.append(result.attempt)
                if result.asset is not None:
                    used_filename = filename
                    logger.info("acquisition: success via %s", download_url)
                    break

            if result is None or result.asset is None:
                raise RuntimeError(
                    f"live download failed for {gse}: all candidate URLs failed"
                )

            assets = [result.asset]
            if "tximportCounts" in used_filename:
                soft_source = SourceRecord(
                    source_id=source_id,
                    database=Database.GEO,
                    accession=gse,
                    url=_family_soft_url(gse),
                    title=f"{gse} family SOFT",
                    retrieved_at=retrieved_at,
                )
                soft_result = await _try_acquire(
                    soft_source, f"{gse}_family.soft.gz", ctx, cache, http, gse
                )
                if soft_result.asset is None:
                    raise RuntimeError(
                        f"live download failed for {gse}: family SOFT required "
                        "when tximport counts are available"
                    )
                assets.append(soft_result.asset)
                attempts.append(soft_result.attempt)

        # Surface live acquisition progress. See docs/REVIEW_2026-07-18.md §4.
        ctx.emit_progress_sync(
            stage=StageName.ACQUISITION,
            kind="downloaded_bytes",
            current=result.asset.size_bytes,
            total=None,
            detail={
                "source": "geo",
                "accession": gse,
                "filename": used_filename,
                "records": 1,
            },
        )
        output = AcquisitionOutput(
            source_assets=assets,
            download_attempts=attempts,
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
