"""Verified streaming acquisition of immutable source bytes."""

from __future__ import annotations

import contextlib
import hashlib
import os
import shutil
import tempfile
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
from app.tools.content_cache import ContentCache
from app.tools.workdir import TaskWorkDir

_ALLOWED_HOSTS = frozenset(
    {
        "ftp.ncbi.nlm.nih.gov",
        "eutils.ncbi.nlm.nih.gov",
        "www.ncbi.nlm.nih.gov",
    }
)
_MAX_REDIRECTS = 5


class AcquisitionFailure(RuntimeError):
    def __init__(self, code: ErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code


def _validate_source_url(url: str) -> str:
    parsed = urlsplit(url)
    if parsed.scheme != "https":
        raise AcquisitionFailure(
            ErrorCode.VALIDATION_ERROR, "source URL must use HTTPS"
        )
    if parsed.username or parsed.password:
        raise AcquisitionFailure(
            ErrorCode.VALIDATION_ERROR, "source URL credentials are forbidden"
        )
    if parsed.hostname not in _ALLOWED_HOSTS:
        raise AcquisitionFailure(
            ErrorCode.VALIDATION_ERROR, "source URL host is not allowed"
        )
    if parsed.port not in (None, 443):
        raise AcquisitionFailure(
            ErrorCode.VALIDATION_ERROR, "source URL port is not allowed"
        )
    return parsed.hostname


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
        digest = hashlib.sha256()
        timeout = httpx.Timeout(connect=10.0, read=60.0, write=30.0, pool=10.0)
        current_url = source.url
        redirect_count = 0
        media_type = "application/octet-stream"
        while True:
            async with http.stream(
                "GET", current_url, follow_redirects=False, timeout=timeout
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

        blob_path = _publish_cache(part_path, cache, checksum)
        asset_id = asset_id_from_sha256(checksum)
        destination = _publish_task_asset(
            blob_path, workdir, asset_id, filename, checksum
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
        error_message = f"download timed out: {error}"
    except httpx.HTTPError as error:
        error_code = ErrorCode.NETWORK_ERROR
        error_message = f"download failed: {error}"
    except (OSError, ValueError) as error:
        error_code = ErrorCode.INTERNAL_ERROR
        error_message = f"download failed: {error}"
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
