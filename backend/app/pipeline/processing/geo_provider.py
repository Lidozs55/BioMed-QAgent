"""Phase 5 D1: minimal GEO acquisition provider layer.

Stable builtin provider ids ``geo.series.v1`` (series asset acquisition in
the fixed V1 priority order) and ``geo.platform.v1`` (GPL annotation
acquisition). The layer owns accession validation, URL construction, download
attempts (size limits / checksum), fixture asset selection and SourceAsset
formation — it does NOT parse expression rows, decide namespaces, map probes,
select profiles or publish.

Implementation is ordinary module functions plus an explicit provider_id
dispatcher; there is deliberately NO plugin registry.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

import httpx

from app.datasets.contracts import AnnotationStatus, PlatformRecord
from app.domain.contracts import (
    Database,
    DataLevel,
    DownloadAttempt,
    DownloadStatus,
    ErrorCode,
    SourceRecord,
    generate_prefixed_uuid,
    make_source_id,
)
from app.integrations.acquisition import (
    AcquisitionResult,
    acquire_source,
)
from app.pipeline.processing.geo_annotation import (
    ANNOTATION_UNAVAILABLE,
    discover_annotation_file,
    parse_platform_annotation,
    platform_table_columns,
)
from app.tools.content_cache import ContentCache, canonical_request_hash
from app.tools.workdir import TaskWorkDir

logger = logging.getLogger(__name__)

# Stable builtin provider ids (D1). These are plain identifiers resolved by
# the explicit dispatcher below — not a plugin registry.
GEO_SERIES_PROVIDER_ID = "geo.series.v1"
GEO_PLATFORM_PROVIDER_ID = "geo.platform.v1"
GEO_PROVIDER_IDS = frozenset({GEO_SERIES_PROVIDER_ID, GEO_PLATFORM_PROVIDER_ID})

# 100 MB safety cap shared by series and platform acquisition.
MAX_BYTES = 100 * 1024 * 1024

_FTP_ROOT = "https://ftp.ncbi.nlm.nih.gov/geo"
_PLATFORM_FTP_ROOT = f"{_FTP_ROOT}/platforms"


@dataclass(frozen=True)
class GeoProvider:
    """Resolved builtin GEO provider identity (explicit dispatcher result)."""

    provider_id: str
    kind: Literal["series", "platform"]


def resolve_provider(provider_id: str) -> GeoProvider:
    """Resolve a builtin GEO provider id; unknown ids raise ``ValueError``.

    This is the explicit provider_id dispatcher required by D1. New GEO
    providers would extend this function (or the ids above) — there is no
    plugin registry to register into.
    """
    if provider_id == GEO_SERIES_PROVIDER_ID:
        return GeoProvider(provider_id=GEO_SERIES_PROVIDER_ID, kind="series")
    if provider_id == GEO_PLATFORM_PROVIDER_ID:
        return GeoProvider(provider_id=GEO_PLATFORM_PROVIDER_ID, kind="platform")
    raise ValueError(
        f"unknown GEO provider id {provider_id!r}; "
        f"expected one of {sorted(GEO_PROVIDER_IDS)}"
    )


# --- accession validation ----------------------------------------------------


def normalize_series_accession(value: str) -> str:
    """Validate and uppercase a GEO series accession (``GSE\\d+``)."""
    normalized = value.strip().upper()
    if not normalized.startswith("GSE") or not normalized[3:].isdigit():
        raise ValueError(f"invalid GEO series accession: {value!r}")
    return normalized


def normalize_platform_accession(value: str) -> str:
    """Validate and uppercase a GEO platform accession (``GPL\\d+``)."""
    normalized = value.strip().upper()
    if not normalized.startswith("GPL") or not normalized[3:].isdigit():
        raise ValueError(f"invalid GEO platform accession: {value!r}")
    return normalized


# --- series URL construction (mirrors the verified V1 layout) ----------------


def series_dir_prefix(gse: str) -> str:
    """Return the NCBI GEO series directory prefix (``GSE178nnn``).

    NCBI stores series under ``geo/series/GSE{prefix}nnn/`` where the numeric
    prefix is the accession with its last three digits replaced by ``nnn``
    (e.g. GSE15471 → GSE15nnn). Accessions with three or fewer digits use
    ``GSEnnn``.
    """
    normalized = normalize_series_accession(gse)
    digits = normalized[3:]
    prefix = "nnn" if len(digits) <= 3 else f"{digits[:-3]}nnn"
    return f"GSE{prefix}"


def series_counts_url(gse: str) -> str:
    """NCBI supplemental tximport counts URL for a series."""
    normalized = normalize_series_accession(gse)
    return (
        f"{_FTP_ROOT}/series/{series_dir_prefix(normalized)}/{normalized}/"
        f"suppl/{normalized}_tximportCounts.txt.gz"
    )


def series_family_soft_url(gse: str) -> str:
    """NCBI family SOFT URL for a series."""
    normalized = normalize_series_accession(gse)
    return (
        f"{_FTP_ROOT}/series/{series_dir_prefix(normalized)}/{normalized}/"
        f"soft/{normalized}_family.soft.gz"
    )


def series_matrix_url(gse: str) -> str:
    """NCBI series matrix URL (universally available fallback)."""
    normalized = normalize_series_accession(gse)
    return (
        f"{_FTP_ROOT}/series/{series_dir_prefix(normalized)}/{normalized}/"
        f"matrix/{normalized}_series_matrix.txt.gz"
    )


def series_suppl_directory_url(gse: str) -> str:
    """NCBI supplementary files directory URL for a series."""
    normalized = normalize_series_accession(gse)
    return (
        f"{_FTP_ROOT}/series/{series_dir_prefix(normalized)}/{normalized}/suppl/"
    )


# --- platform URL construction (mirrors the verified V1 layout) --------------


def platform_dir_prefix(gpl: str) -> str:
    """Return the NCBI GEO platform directory prefix (``GPL19nnn``).

    NCBI stores platforms under ``geo/platforms/GPL{prefix}nnn/`` where the
    numeric prefix is the accession with its last three digits replaced by
    ``nnn`` (GPL19072 → GPL19nnn, GPL4133 → GPL4nnn, GPL570 → GPLnnn).
    """
    normalized = normalize_platform_accession(gpl)
    digits = normalized[3:]
    prefix = "nnn" if len(digits) <= 3 else f"{digits[:-3]}nnn"
    return f"GPL{prefix}"


def platform_suppl_listing_url(gpl: str) -> str:
    """suppl/ listing URL for a platform.

    # seam: test-only — pinned URL-layout tests (review-loop R3-4); live
    acquisition uses ``discover_annotation_file`` + ``acquire_platform_annotation``.
    """
    normalized = normalize_platform_accession(gpl)
    return f"{_PLATFORM_FTP_ROOT}/{platform_dir_prefix(normalized)}/{normalized}/suppl/"


def platform_annot_listing_url(gpl: str) -> str:
    """annot/ listing URL for a platform.

    # seam: test-only — pinned URL-layout tests (review-loop R3-4); live
    acquisition uses ``discover_annotation_file`` + ``acquire_platform_annotation``.
    """
    normalized = normalize_platform_accession(gpl)
    return f"{_PLATFORM_FTP_ROOT}/{platform_dir_prefix(normalized)}/{normalized}/annot/"


def platform_file_url(gpl: str, subdir: str, filename: str) -> str:
    normalized = normalize_platform_accession(gpl)
    return (
        f"{_PLATFORM_FTP_ROOT}/{platform_dir_prefix(normalized)}/{normalized}/"
        f"{subdir}/{filename}"
    )


def platform_landing_url(gpl: str) -> str:
    """NCBI GEO query landing URL for a platform."""
    return (
        f"https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?"
        f"acc={normalize_platform_accession(gpl)}"
    )


# --- fixture asset selection -------------------------------------------------


def select_series_fixture_assets(
    fixture_dir: Path, gse: str
) -> list[tuple[str, Path]]:
    """Return ``[(logical_name, path)]`` for the fixture series assets.

    Logical names: ``tximport_counts``, ``family_soft``, ``series_matrix``,
    ``suppl_expression``. Assets that are absent from the fixture directory
    are simply omitted — callers decide the acquisition order and fallback.
    """
    normalized = normalize_series_accession(gse)
    lower = normalized.lower()
    candidates = [
        ("tximport_counts", fixture_dir / "tximport_counts_slice.tsv"),
        ("family_soft", fixture_dir / f"{lower}_family.soft.gz"),
        ("series_matrix", fixture_dir / f"{lower}_series_matrix.txt.gz"),
    ]
    return [(name, path) for name, path in candidates if path.is_file()]


def select_platform_fixture_asset(
    fixture_dir: Path, gpl: str
) -> Path | None:
    """Return the fixture platform annotation asset for *gpl* or ``None``.

    Convention: ``{fixture_dir}/platforms/{gpl}_annot.txt.gz`` (lowercase
    accession), mirroring the NCBI ``suppl`` layout.
    """
    normalized = normalize_platform_accession(gpl)
    candidate = fixture_dir / "platforms" / f"{normalized.lower()}_annot.txt.gz"
    return candidate if candidate.is_file() else None


# --- download attempts (fail closed) -----------------------------------------


async def acquire_series_asset(
    *,
    source: SourceRecord,
    filename: str,
    workdir: TaskWorkDir,
    cache: ContentCache,
    http: httpx.AsyncClient,
    max_bytes: int = MAX_BYTES,
    expected_sha256: str | None = None,
    expected_size: int | None = None,
) -> AcquisitionResult:
    """Download one GEO series asset through ``acquire_source`` (fail closed).

    Size limits and checksums are enforced by ``acquire_source``; any
    failure — network, checksum mismatch, size overflow — is returned as a
    FAILED ``DownloadAttempt`` with ``asset=None`` so callers can record the
    complete fallback chain in ``download_log.csv`` instead of raising.
    """
    try:
        return await acquire_source(
            source=source,
            filename=filename,
            workdir=workdir,
            cache=cache,
            http=http,
            data_level=DataLevel.REPOSITORY_PROCESSED,
            max_bytes=max_bytes,
            expected_sha256=expected_sha256,
            expected_size=expected_size,
        )
    except Exception as exc:  # noqa: BLE001 — fail closed into a FAILED attempt
        logger.warning(
            "geo provider: series asset download failed for %s: %s",
            source.url, exc,
        )
        return AcquisitionResult(
            attempt=DownloadAttempt(
                attempt_id=generate_prefixed_uuid("download_attempt"),
                source_id=source.source_id,
                url=source.url,
                status=DownloadStatus.FAILED,
                bytes_received=0,
                error_code=ErrorCode.NETWORK_ERROR,
                error_message=str(exc),
                started_at=datetime.now(UTC),
                finished_at=datetime.now(UTC),
            ),
        )


# --- platform annotation acquisition -----------------------------------------


@dataclass(frozen=True)
class PlatformAnnotationResult:
    """Parsed GPL annotation plus the provenance needed for a PlatformRecord."""

    gene_map: dict[str, str]
    status: str
    probe_column: str | None
    gene_column: str | None
    annotation_sha256: str | None
    source_url: str | None


def _parse_annotation_bytes(data: bytes, url: str | None) -> PlatformAnnotationResult:
    gene_map, status = parse_platform_annotation(data)
    probe_column, gene_column = platform_table_columns(data)
    return PlatformAnnotationResult(
        gene_map=gene_map,
        status=status,
        probe_column=probe_column,
        gene_column=gene_column,
        annotation_sha256=hashlib.sha256(data).hexdigest(),
        source_url=url,
    )


def acquire_platform_annotation(
    gpl: str,
    *,
    cache: ContentCache,
    fixture_dir: Path | None = None,
    client: httpx.Client | None = None,
    max_bytes: int = MAX_BYTES,
) -> PlatformAnnotationResult:
    """Acquire and parse the GPL annotation (geo.platform.v1).

    Fixture mode (``fixture_dir`` set) reads ``platforms/{gpl}_annot.txt.gz``
    from the fixture directory — no network. Live mode discovers the
    annotation file (suppl/annot layouts), downloads it through a content
    cache with a ``max_bytes`` cap, and verifies the sha256 of what was
    cached.

    Discovery/download failures and over-size payloads degrade to
    ``ANNOTATION_UNAVAILABLE`` (fail closed) rather than raising — a missing
    probe→gene map is a data-quality warning, not a processing failure.
    """
    normalized = normalize_platform_accession(gpl)
    if fixture_dir is not None:
        fixture_path = select_platform_fixture_asset(fixture_dir, normalized)
        if fixture_path is None:
            logger.info("geo provider: no fixture annotation for %s", normalized)
            return PlatformAnnotationResult(
                {}, ANNOTATION_UNAVAILABLE, None, None, None, None
            )
        try:
            data = fixture_path.read_bytes()
        except OSError as exc:
            logger.warning(
                "geo provider: cannot read fixture annotation %s: %s",
                fixture_path, exc,
            )
            return PlatformAnnotationResult(
                {}, ANNOTATION_UNAVAILABLE, None, None, None, None
            )
        # Fixture bytes stand in for the live download; the sha256 is the
        # content-address of the fixture asset.
        return _parse_annotation_bytes(data, url=None)

    # Live mode: content-cached discovery + download with a size cap. The
    # cache key is the platform identity, so a warm cache skips the network.
    request_hash = canonical_request_hash(
        "geo", normalized, f"{_PLATFORM_FTP_ROOT}/{platform_dir_prefix(normalized)}/{normalized}/"
    )
    cached = cache.read_metadata(request_hash)
    if cached is not None:
        blob = cache.blob_path(cached["sha256"])
        if blob.is_file():
            logger.info("geo provider: platform annotation cache hit for %s", normalized)
            return _parse_annotation_bytes(blob.read_bytes(), url=cached.get("url"))

    owns_client = client is None
    if client is None:
        client = httpx.Client(
            follow_redirects=True,
            timeout=httpx.Timeout(connect=10.0, read=60.0, write=30.0, pool=10.0),
            headers={"User-Agent": "Mozilla/5.0 (BioMedQAgent pipeline)"},
        )
    try:
        located = discover_annotation_file(client, normalized)
        if located is None:
            logger.warning("geo provider: no annotation file for %s", normalized)
            return PlatformAnnotationResult(
                {}, ANNOTATION_UNAVAILABLE, None, None, None, None
            )
        subdir, filename = located
        url = platform_file_url(normalized, subdir, filename)
        try:
            response = client.get(url)
            response.raise_for_status()
            data = response.content
        except httpx.HTTPError as exc:
            logger.warning(
                "geo provider: annotation download failed for %s: %s", url, exc
            )
            return PlatformAnnotationResult(
                {}, ANNOTATION_UNAVAILABLE, None, None, None, None
            )
        if len(data) > max_bytes:
            logger.warning(
                "geo provider: annotation %s exceeds max_bytes (%d)", normalized, max_bytes
            )
            return PlatformAnnotationResult(
                {}, ANNOTATION_UNAVAILABLE, None, None, None, None
            )
        checksum = hashlib.sha256(data).hexdigest()
        blob = cache.blob_path(checksum)
        blob.write_bytes(data)
        cache.write_metadata(
            request_hash,
            {
                "sha256": checksum,
                "filename": filename,
                "media_type": "application/gzip",
                "url": url,
            },
        )
        logger.info(
            "geo provider: cached %s bytes annotation for %s (%s)",
            len(data), normalized, filename,
        )
        return _parse_annotation_bytes(data, url=url)
    finally:
        if owns_client:
            client.close()


# --- PlatformRecord construction (D3) ----------------------------------------


def target_namespace_for_gene_column(
    gene_column: str | None,
) -> Literal["gene_symbol", "ensembl_gene"] | None:
    """Map a SOFT gene column to the pipeline's mapping target namespace.

    ``GENE_SYMBOL``/``GENE_NAME`` map to ``gene_symbol``; ``ENSEMBL_ID`` maps
    to ``ensembl_gene``. Every other recognized gene column is treated as
    ``gene_symbol`` — the V1 series-matrix parser labels mapped rows with
    ``gene_id_namespace="gene_symbol"`` regardless of the source column
    (legacy V1 behavior; V2 canonicalization owns the honest namespace).
    """
    if gene_column is None:
        return None
    if gene_column == "ENSEMBL_ID":
        return "ensembl_gene"
    return "gene_symbol"


def build_platform_record(
    gpl: str,
    result: PlatformAnnotationResult,
    *,
    source_id: str,
) -> PlatformRecord:
    """Build the D3 ``PlatformRecord`` for one GPL annotation attempt."""
    status = AnnotationStatus(result.status)
    if status is AnnotationStatus.MAPPED:
        target_namespace = target_namespace_for_gene_column(result.gene_column)
        if target_namespace is None:
            # Defensive: MAPPED requires a non-None target; the column scan
            # and the parser share the same priority, so this is unreachable
            # in practice — but never emit an invalid record.
            target_namespace = "gene_symbol"
        return PlatformRecord(
            platform_id=gpl,
            source_id=source_id,
            annotation_asset_id=None,
            annotation_status=status,
            probe_id_field=result.probe_column,
            gene_id_field=result.gene_column,
            target_namespace=target_namespace,
            mapping_source_url=result.source_url,
            annotation_sha256=result.annotation_sha256,
        )
    return PlatformRecord(
        platform_id=gpl,
        source_id=source_id,
        annotation_asset_id=None,
        annotation_status=status,
        probe_id_field=result.probe_column,
        gene_id_field=None,
        target_namespace=None,
        mapping_source_url=result.source_url,
        annotation_sha256=result.annotation_sha256,
    )


def platform_not_attempted_record(gpl: str, *, source_id: str) -> PlatformRecord:
    """Declared-but-unattempted GPL record (D8: no unconditional first GPL)."""
    return PlatformRecord(
        platform_id=gpl,
        source_id=source_id,
        annotation_status=AnnotationStatus.NOT_ATTEMPTED,
    )


def platform_source_id(gpl: str) -> str:
    """Deterministic logical source id for a GPL platform record."""
    return make_source_id(
        Database.GEO, normalize_platform_accession(gpl), platform_landing_url(gpl)
    )
