"""Verified streaming acquisition of immutable source bytes."""

from __future__ import annotations

import contextlib
import hashlib
import ipaddress
import os
import shutil
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import httpx

from app.domain.contracts import (
    AcquisitionResult,
    DataLevel,
    DownloadAttempt,
    DownloadStatus,
    ErrorCode,
    SourceAsset,
    SourceRecord,
    asset_id_from_sha256,
    generate_prefixed_uuid,
)
from app.tools.content_cache import ContentCache, canonical_request_hash
from app.tools.network_safety import (
    PublicHttpTarget,
    UnsafeUrlError,
    resolve_public_http_target,
)
from app.tools.workdir import TaskWorkDir

_ALLOWED_HOSTS = frozenset(
    {
        # NCBI (PubMed, GEO, PMC)
        "ftp.ncbi.nlm.nih.gov",
        "eutils.ncbi.nlm.nih.gov",
        "www.ncbi.nlm.nih.gov",
        # GDC
        "api.gdc.cancer.gov",
        # RCSB PDB
        "files.rcsb.org",
        "search.rcsb.org",
        "data.rcsb.org",
        # PubChem
        "pubchem.ncbi.nlm.nih.gov",
        # Reactome
        "reactome.org",
        # UCSC Xena (S3)
        "toil-xena-hub.s3.us-east-1.amazonaws.com",
        # Unpaywall (DOI → OA PDF URL lookup, TODO §8.4)
        "api.unpaywall.org",
        # Europe PMC (PMCID → fullTextXML, domestic-reachable alternative
        # to NCBI PMC; project_memory L1 hard constraint)
        "www.ebi.ac.uk",
    }
)
_MAX_REDIRECTS = 5


class AcquisitionFailure(RuntimeError):
    def __init__(self, code: ErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class ValidatedRecipeTarget:
    """Original Recipe URL plus its one-time public, address-pinned target."""

    url: str
    host: str
    public_target: PublicHttpTarget


def _validate_source_url(url: str) -> str:
    return _validate_https_source_url(
        url,
        allowed_hosts=_ALLOWED_HOSTS,
        resolve_public=False,
    )


def validate_recipe_source_url(
    url: str,
    allowed_hosts: list[str],
) -> ValidatedRecipeTarget:
    """Validate one Recipe URL against its exact dynamic host boundary."""

    hostname = _validate_https_source_url(
        url,
        allowed_hosts=frozenset(allowed_hosts),
        resolve_public=False,
    )
    try:
        public_target = resolve_public_http_target(url, require_https=True)
    except UnsafeUrlError as error:
        raise AcquisitionFailure(ErrorCode.VALIDATION_ERROR, str(error)) from error
    return ValidatedRecipeTarget(
        url=url,
        host=hostname,
        public_target=public_target,
    )


def _validate_https_source_url(
    url: str,
    *,
    allowed_hosts: frozenset[str],
    resolve_public: bool,
) -> str:
    try:
        parsed = urlsplit(url)
        username = parsed.username
        password = parsed.password
        hostname = (parsed.hostname or "").lower().rstrip(".")
        port = parsed.port
    except ValueError as error:
        raise AcquisitionFailure(
            ErrorCode.VALIDATION_ERROR, "source URL is malformed"
        ) from error
    if parsed.scheme != "https":
        raise AcquisitionFailure(
            ErrorCode.VALIDATION_ERROR, "source URL must use HTTPS"
        )
    if username is not None or password is not None:
        raise AcquisitionFailure(
            ErrorCode.VALIDATION_ERROR, "source URL credentials are forbidden"
        )
    if hostname not in allowed_hosts:
        raise AcquisitionFailure(
            ErrorCode.VALIDATION_ERROR, "source URL host is not allowed"
        )
    if port not in (None, 443):
        raise AcquisitionFailure(
            ErrorCode.VALIDATION_ERROR, "source URL port is not allowed"
        )
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        pass
    else:
        raise AcquisitionFailure(
            ErrorCode.VALIDATION_ERROR, "source URL IP literals are forbidden"
        )
    if resolve_public:
        try:
            resolve_public_http_target(url, require_https=True)
        except UnsafeUrlError as error:
            raise AcquisitionFailure(ErrorCode.VALIDATION_ERROR, str(error)) from error
    return hostname


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _copy_verified_atomic(
    source_path: Path,
    destination: Path,
    checksum: str,
    *,
    mismatch_message: str,
) -> Path:
    """Copy through a verified sibling temp file before atomic publication."""

    temporary_path: Path | None = None
    try:
        with (
            source_path.open("rb") as source,
            tempfile.NamedTemporaryFile(
                mode="xb",
                dir=destination.parent,
                prefix=f".{destination.name}.",
                suffix=".tmp",
                delete=False,
            ) as target,
        ):
            temporary_path = Path(target.name)
            shutil.copyfileobj(source, target, length=1024 * 1024)
            target.flush()
            os.fsync(target.fileno())

        if _sha256_file(temporary_path) != checksum:
            raise AcquisitionFailure(ErrorCode.CHECKSUM_MISMATCH, mismatch_message)
        if destination.exists():
            if _sha256_file(destination) != checksum:
                raise AcquisitionFailure(ErrorCode.CHECKSUM_MISMATCH, mismatch_message)
            return destination

        os.replace(temporary_path, destination)
        temporary_path = None
        if _sha256_file(destination) != checksum:
            raise AcquisitionFailure(ErrorCode.CHECKSUM_MISMATCH, mismatch_message)
        return destination
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def _publish_cache(part_path: Path, cache: ContentCache, checksum: str) -> Path:
    blob_path = cache.blob_path(checksum)
    if blob_path.exists():
        if _sha256_file(blob_path) != checksum:
            raise AcquisitionFailure(
                ErrorCode.CHECKSUM_MISMATCH, "cached blob checksum mismatch"
            )
        return blob_path
    return _copy_verified_atomic(
        part_path,
        blob_path,
        checksum,
        mismatch_message="published cache checksum mismatch",
    )


def _publish_task_asset(
    blob_path: Path,
    workdir: TaskWorkDir,
    asset_id: str,
    filename: str,
    checksum: str,
) -> Path:
    if Path(filename).name != filename or not filename:
        raise AcquisitionFailure(ErrorCode.VALIDATION_ERROR, "unsafe source filename")
    destination = workdir.source_assets / asset_id / filename
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        if _sha256_file(destination) != checksum:
            raise AcquisitionFailure(
                ErrorCode.CHECKSUM_MISMATCH, "existing task asset differs"
            )
        return destination
    try:
        os.link(blob_path, destination)
    except OSError:
        try:
            return _copy_verified_atomic(
                blob_path,
                destination,
                checksum,
                mismatch_message="task asset checksum mismatch",
            )
        except AcquisitionFailure:
            with contextlib.suppress(OSError):
                destination.parent.rmdir()
            raise
    if _sha256_file(destination) != checksum:
        raise AcquisitionFailure(
            ErrorCode.CHECKSUM_MISMATCH, "task asset checksum mismatch"
        )
    return destination


async def acquire_source(
    *,
    source: SourceRecord,
    filename: str,
    workdir: TaskWorkDir,
    cache: ContentCache,
    http: httpx.AsyncClient,
    data_level: DataLevel,
    max_bytes: int,
    expected_size: int | None = None,
    expected_sha256: str | None = None,
    expected_md5: str | None = None,
    expected_media_types: frozenset[str] | None = None,
    accept: str = "text/tab-separated-values",
    request_headers: Mapping[str, str] | None = None,
) -> AcquisitionResult:
    attempt_id = generate_prefixed_uuid("download_attempt")
    started_at = datetime.now(UTC)
    part_path = workdir.download_temp_file(f"{attempt_id}.part")
    bytes_received = 0
    try:
        origin_host = _validate_source_url(source.url)
        if max_bytes <= 0:
            raise AcquisitionFailure(
                ErrorCode.VALIDATION_ERROR, "max_bytes must be positive"
            )

        # --- Request-level cache hit: skip network if metadata + blob exist ---
        req_hash = canonical_request_hash(
            source.database.value, source.accession, source.url
        )
        cached = cache.read_metadata(req_hash)
        if cached is not None:
            cached_sha = cached["sha256"]
            cached_blob = cache.blob_path(cached_sha)
            if cached_blob.is_file() and _sha256_file(cached_blob) == cached_sha:
                cached_size = cached_blob.stat().st_size
                cached_media_type = cached.get(
                    "media_type", "application/octet-stream"
                ).split(";", 1)[0].strip().lower()
                if cached_size > max_bytes:
                    raise AcquisitionFailure(
                        ErrorCode.DOWNLOAD_INCOMPLETE,
                        "cached download exceeds maximum size",
                    )
                if expected_size is not None and cached_size != expected_size:
                    raise AcquisitionFailure(
                        ErrorCode.DOWNLOAD_INCOMPLETE,
                        "cached download expected size mismatch",
                    )
                if expected_sha256 and cached_sha != expected_sha256.lower():
                    raise AcquisitionFailure(
                        ErrorCode.CHECKSUM_MISMATCH,
                        "cached download expected SHA-256 mismatch",
                    )
                if (
                    expected_media_types
                    and cached_media_type not in expected_media_types
                ):
                    raise AcquisitionFailure(
                        ErrorCode.VALIDATION_ERROR,
                        f"unexpected cached content type: "
                        f"{cached_media_type or 'missing'}",
                    )
                asset_id = asset_id_from_sha256(cached_sha)
                destination = _publish_task_asset(
                    cached_blob, workdir, asset_id, filename, cached_sha
                )
                finished_at = datetime.now(UTC)
                attempt = DownloadAttempt(
                    attempt_id=attempt_id,
                    source_id=source.source_id,
                    url=source.url,
                    status=DownloadStatus.SUCCEEDED,
                    bytes_received=cached_size,
                    started_at=started_at,
                    finished_at=finished_at,
                )
                return AcquisitionResult(
                    attempt=attempt,
                    asset=SourceAsset(
                        asset_id=asset_id,
                        kind="source",
                        relative_path=destination.relative_to(workdir.root).as_posix(),
                        sha256=cached_sha,
                        size_bytes=cached_size,
                        media_type=cached_media_type,
                        source_id=source.source_id,
                        successful_attempt_id=attempt_id,
                        data_level=data_level,
                    ),
                )

        digest = hashlib.sha256()
        md5_digest = hashlib.md5()
        timeout = httpx.Timeout(connect=10.0, read=60.0, write=30.0, pool=10.0)
        current_url = source.url
        redirect_count = 0
        media_type = "application/octet-stream"
        headers = dict(request_headers or {})
        headers["Accept"] = accept
        while True:
            async with http.stream(
                "GET",
                current_url,
                headers=headers,
                follow_redirects=False,
                timeout=timeout,
            ) as response:
                if response.is_redirect:
                    location = response.headers.get("Location")
                    if not location:
                        raise AcquisitionFailure(
                            ErrorCode.NETWORK_ERROR,
                            "download redirect omitted Location",
                        )
                    if redirect_count >= _MAX_REDIRECTS:
                        raise AcquisitionFailure(
                            ErrorCode.NETWORK_ERROR,
                            "download exceeded redirect limit",
                        )
                    redirected_url = urljoin(current_url, location)
                    redirected_host = _validate_source_url(redirected_url)
                    if redirected_host != origin_host:
                        raise AcquisitionFailure(
                            ErrorCode.VALIDATION_ERROR,
                            "download redirect changed host",
                        )
                    current_url = redirected_url
                    redirect_count += 1
                    continue
                if not response.is_success:
                    raise AcquisitionFailure(
                        ErrorCode.NETWORK_ERROR,
                        f"download returned HTTP {response.status_code}",
                    )
                declared_length = response.headers.get("Content-Length")
                if declared_length is not None and int(declared_length) > max_bytes:
                    raise AcquisitionFailure(
                        ErrorCode.DOWNLOAD_INCOMPLETE,
                        "declared content length exceeds maximum",
                    )
                with part_path.open("xb") as target:
                    async for chunk in response.aiter_bytes():
                        bytes_received += len(chunk)
                        if bytes_received > max_bytes:
                            raise AcquisitionFailure(
                                ErrorCode.DOWNLOAD_INCOMPLETE,
                                "download exceeded maximum size",
                            )
                        target.write(chunk)
                        digest.update(chunk)
                        md5_digest.update(chunk)
                    target.flush()
                    os.fsync(target.fileno())

                if bytes_received == 0:
                    raise AcquisitionFailure(
                        ErrorCode.DOWNLOAD_INCOMPLETE, "download was empty"
                    )
                if declared_length is not None and bytes_received != int(
                    declared_length
                ):
                    raise AcquisitionFailure(
                        ErrorCode.DOWNLOAD_INCOMPLETE, "content length mismatch"
                    )
                media_type = response.headers.get(
                    "Content-Type", "application/octet-stream"
                ).split(";", 1)[0].strip().lower()
                if expected_media_types and media_type not in expected_media_types:
                    raise AcquisitionFailure(
                        ErrorCode.VALIDATION_ERROR,
                        f"unexpected content type: {media_type or 'missing'}",
                    )
                break

        if expected_size is not None and bytes_received != expected_size:
            raise AcquisitionFailure(
                ErrorCode.DOWNLOAD_INCOMPLETE, "expected size mismatch"
            )
        checksum = digest.hexdigest()
        if expected_sha256 and checksum != expected_sha256.lower():
            raise AcquisitionFailure(
                ErrorCode.CHECKSUM_MISMATCH, "expected SHA-256 mismatch"
            )
        # GDC files API exposes ``md5sum`` (32-char MD5) but not SHA-256;
        # REVIEW 2026-08-05 P1-4: verify against the official MD5 when provided
        # (previously the sha256-only branch silently skipped it).
        if expected_md5 and md5_digest.hexdigest() != expected_md5.lower():
            raise AcquisitionFailure(
                ErrorCode.CHECKSUM_MISMATCH, "expected MD5 mismatch"
            )

        blob_path = _publish_cache(part_path, cache, checksum)
        asset_id = asset_id_from_sha256(checksum)
        destination = _publish_task_asset(
            blob_path, workdir, asset_id, filename, checksum
        )
        # Persist request-level metadata so future requests skip the network.
        cache.write_metadata(
            req_hash,
            {
                "sha256": checksum,
                "size_bytes": str(bytes_received),
                "media_type": media_type.split(";", 1)[0],
            },
        )
        finished_at = datetime.now(UTC)
        attempt = DownloadAttempt(
            attempt_id=attempt_id,
            source_id=source.source_id,
            url=source.url,
            status=DownloadStatus.SUCCEEDED,
            bytes_received=bytes_received,
            started_at=started_at,
            finished_at=finished_at,
        )
        return AcquisitionResult(
            attempt=attempt,
            asset=SourceAsset(
                asset_id=asset_id,
                kind="source",
                relative_path=destination.relative_to(workdir.root).as_posix(),
                sha256=checksum,
                size_bytes=bytes_received,
                media_type=media_type.split(";", 1)[0],
                source_id=source.source_id,
                successful_attempt_id=attempt_id,
                data_level=data_level,
            ),
        )
    except AcquisitionFailure as error:
        error_code = error.code
        error_message = str(error)
    except httpx.TimeoutException as error:
        error_code = ErrorCode.TIMEOUT
        error_message = f"download timed out: {type(error).__name__}: {error}"
    except httpx.HTTPError as error:
        error_code = ErrorCode.NETWORK_ERROR
        error_message = f"download failed: {type(error).__name__}: {error}"
    except (OSError, ValueError) as error:
        error_code = ErrorCode.INTERNAL_ERROR
        error_message = f"download failed: {type(error).__name__}: {error}"
    finally:
        part_path.unlink(missing_ok=True)

    finished_at = datetime.now(UTC)
    return AcquisitionResult(
        attempt=DownloadAttempt(
            attempt_id=attempt_id,
            source_id=source.source_id,
            url=source.url,
            status=DownloadStatus.FAILED,
            bytes_received=bytes_received,
            error_code=error_code,
            error_message=error_message,
            started_at=started_at,
            finished_at=finished_at,
        )
    )


async def acquire_publication_with_fallback(
    *,
    source: SourceRecord,
    filename: str,
    workdir: TaskWorkDir,
    cache: ContentCache,
    http: httpx.AsyncClient,
    max_bytes: int,
    data_level: DataLevel,
    doi: str | None = None,
    pmcid: str | None = None,
) -> AcquisitionResult:
    """Acquire a publication PDF/XML via the 3-tier fallback chain.

    Implements the project_memory L1 hard constraint:
        pdf_url (direct) → Unpaywall (DOI, 5s quick failure) → EPMC fullTextXML

    Tier order:
        1. ``source.url`` — direct download via ``acquire_source()`` (skipped
           if ``source.url`` is empty or not a PDF-like URL).
        2. Unpaywall — resolve ``doi`` to an OA pdf_url, then download via
           ``acquire_source()``. 5-second quick failure per project_memory.
        3. Europe PMC — fetch ``fullTextXML`` by ``pmcid`` and save as an
           ``.xml`` asset (domestically reachable alternative to NCBI PMC).

    Args:
        source: Base SourceRecord; ``source.url`` is the tier-1 candidate.
        filename: Output filename (e.g., ``"PMC7450705.pdf"``).
        doi: DOI for tier 2 (Unpaywall). If ``None``, tier 2 is skipped.
        pmcid: PMCID for tier 3 (EPMC). If ``None``, tier 3 is skipped.
        workdir, cache, http, max_bytes, data_level: Forwarded to
            ``acquire_source()``.

    Returns:
        The first successful ``AcquisitionResult``. The ``asset.media_type``
        field distinguishes PDF (``application/pdf``) from XML
        (``application/xml`` or ``text/xml``).

    Raises:
        AcquisitionFailure: All available tiers failed. The error message
            lists each tier's failure reason.
    """
    from app.integrations.europepmc import EuropePmcError, fetch_full_text_xml
    from app.integrations.unpaywall import UnpaywallError, lookup_pdf_url

    failures: list[str] = []

    # --- Tier 1: direct pdf_url (source.url) ---
    # Only attempt if source.url looks like a direct PDF link. If source.url
    # is a landing page (e.g., a PubMed abstract page), skip to tier 2/3.
    url_lower = source.url.lower()
    looks_like_pdf = (
        url_lower.endswith(".pdf") or "pdf" in url_lower.split("?")[0].split("/")[-1]
    )
    if looks_like_pdf:
        try:
            result = await acquire_source(
                source=source,
                filename=filename,
                workdir=workdir,
                cache=cache,
                http=http,
                data_level=data_level,
                max_bytes=max_bytes,
            )
            if result.asset and result.attempt.status is DownloadStatus.SUCCEEDED:
                return result
            failures.append(
                f"tier1_direct: attempt status={result.attempt.status.value}, "
                f"error={result.attempt.error_message or 'none'}"
            )
        except AcquisitionFailure as exc:
            failures.append(f"tier1_direct: {exc}")
    else:
        failures.append("tier1_direct: skipped (source.url not a direct PDF link)")

    # --- Tier 2: Unpaywall (DOI → pdf_url) ---
    if doi:
        try:
            resolved_pdf_url = await lookup_pdf_url(doi)
        except UnpaywallError as exc:
            failures.append(f"tier2_unpaywall_lookup: {exc}")
        else:
            # Build a new SourceRecord with the resolved URL
            unpaywall_source = source.model_copy(
                update={"url": resolved_pdf_url, "accession": doi}
            )
            try:
                result = await acquire_source(
                    source=unpaywall_source,
                    filename=filename,
                    workdir=workdir,
                    cache=cache,
                    http=http,
                    data_level=data_level,
                    max_bytes=max_bytes,
                )
                if (
                    result.asset
                    and result.attempt.status is DownloadStatus.SUCCEEDED
                ):
                    return result
                failures.append(
                    f"tier2_unpaywall_download: attempt status="
                    f"{result.attempt.status.value}, "
                    f"error={result.attempt.error_message or 'none'}"
                )
            except AcquisitionFailure as exc:
                failures.append(f"tier2_unpaywall_download: {exc}")
    else:
        failures.append("tier2_unpaywall: skipped (no DOI provided)")

    # --- Tier 3: Europe PMC (PMCID → fullTextXML) ---
    if pmcid:
        try:
            xml_bytes = await fetch_full_text_xml(pmcid)
        except EuropePmcError as exc:
            failures.append(f"tier3_epmc: {exc}")
        else:
            # Save XML bytes directly (not via acquire_source streaming,
            # because EPMC client already fetched the full body)
            import hashlib as _hashlib

            checksum = _hashlib.sha256(xml_bytes).hexdigest()
            asset_id = asset_id_from_sha256(checksum)
            # Replace .pdf extension with .xml for EPMC tier
            if "." in filename:
                xml_filename = filename.rsplit(".", 1)[0] + ".xml"
            else:
                xml_filename = f"{filename}.xml"
            attempt_id = generate_prefixed_uuid("download_attempt")
            started_at = datetime.now(UTC)

            # Write to temp, then publish via the same atomic path
            part_path = workdir.download_temp_file(f"{attempt_id}.xml")
            try:
                part_path.write_bytes(xml_bytes)
                destination = _publish_task_asset(
                    part_path, workdir, asset_id, xml_filename, checksum
                )
                finished_at = datetime.now(UTC)
                return AcquisitionResult(
                    attempt=DownloadAttempt(
                        attempt_id=attempt_id,
                        source_id=source.source_id,
                        url=f"https://www.ebi.ac.uk/europepmc/webservices/rest/PMC{pmcid.lstrip('PMC')}/fullTextXML",
                        status=DownloadStatus.SUCCEEDED,
                        bytes_received=len(xml_bytes),
                        started_at=started_at,
                        finished_at=finished_at,
                    ),
                    asset=SourceAsset(
                        asset_id=asset_id,
                        kind="source",
                        relative_path=destination.relative_to(workdir.root).as_posix(),
                        sha256=checksum,
                        size_bytes=len(xml_bytes),
                        media_type="application/xml",
                        source_id=source.source_id,
                        successful_attempt_id=attempt_id,
                        data_level=data_level,
                    ),
                )
            finally:
                part_path.unlink(missing_ok=True)
    else:
        failures.append("tier3_epmc: skipped (no PMCID provided)")

    raise AcquisitionFailure(
        ErrorCode.NETWORK_ERROR,
        "all PDF acquisition tiers failed: " + " | ".join(failures),
    )
