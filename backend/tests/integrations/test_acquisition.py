from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest

from app.domain.contracts import (
    DataLevel,
    Database,
    DownloadStatus,
    ErrorCode,
    SourceRecord,
)
from app.integrations.acquisition import acquire_source
from app.tools.content_cache import ContentCache
from app.tools.workdir import create_task_workdir


NOW = datetime(2026, 7, 12, tzinfo=timezone.utc)
URL = (
    "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE178nnn/GSE178352/"
    "suppl/GSE178352_tximportCounts.txt.gz"
)


def source_record() -> SourceRecord:
    return SourceRecord(
        source_id="src_geo_gse178352",
        database=Database.GEO,
        accession="GSE178352",
        url=URL,
        title="GSE178352 processed counts",
        retrieved_at=NOW,
    )


@pytest.mark.asyncio
async def test_acquire_source_streams_verifies_and_publishes_asset(
    tmp_path: Path,
) -> None:
    content = b"verified gzip-like bytes"
    checksum = hashlib.sha256(content).hexdigest()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=content,
            headers={
                "Content-Length": str(len(content)),
                "Content-Type": "application/gzip",
            },
        )

    workdir = create_task_workdir("task_1", base_dir=str(tmp_path / "tasks"))
    cache = ContentCache(tmp_path / "cache")
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        result = await acquire_source(
            source=source_record(),
            filename="GSE178352_tximportCounts.txt.gz",
            workdir=workdir,
            cache=cache,
            http=http,
            data_level=DataLevel.REPOSITORY_PROCESSED,
            max_bytes=1024,
            expected_size=len(content),
            expected_sha256=checksum,
        )

    assert result.attempt.status is DownloadStatus.SUCCEEDED
    assert result.asset is not None
    assert result.asset.sha256 == checksum
    assert result.asset.data_level is DataLevel.REPOSITORY_PROCESSED
    assert (workdir.root / result.asset.relative_path).read_bytes() == content
    assert cache.blob_path(checksum).read_bytes() == content
    assert list(workdir.parsed.iterdir()) == []


@pytest.mark.asyncio
async def test_checksum_mismatch_never_creates_source_asset(tmp_path: Path) -> None:
    content = b"unexpected"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=content)

    workdir = create_task_workdir("task_2", base_dir=str(tmp_path / "tasks"))
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        result = await acquire_source(
            source=source_record(),
            filename="counts.gz",
            workdir=workdir,
            cache=ContentCache(tmp_path / "cache"),
            http=http,
            data_level=DataLevel.REPOSITORY_PROCESSED,
            max_bytes=1024,
            expected_sha256="aa" * 32,
        )

    assert result.attempt.status is DownloadStatus.FAILED
    assert result.attempt.error_code is ErrorCode.CHECKSUM_MISMATCH
    assert result.asset is None
    assert list(workdir.source_assets.rglob("*")) == []


@pytest.mark.asyncio
async def test_declared_oversize_response_is_rejected_before_body_publish(
    tmp_path: Path,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=b"small",
            headers={"Content-Length": "10000"},
        )

    workdir = create_task_workdir("task_3", base_dir=str(tmp_path / "tasks"))
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        result = await acquire_source(
            source=source_record(),
            filename="counts.gz",
            workdir=workdir,
            cache=ContentCache(tmp_path / "cache"),
            http=http,
            data_level=DataLevel.REPOSITORY_PROCESSED,
            max_bytes=100,
        )

    assert result.attempt.status is DownloadStatus.FAILED
    assert result.attempt.error_code is ErrorCode.DOWNLOAD_INCOMPLETE
    assert result.asset is None


@pytest.mark.asyncio
async def test_content_cache_is_reused_across_tasks(tmp_path: Path) -> None:
    content = b"shared verified content"
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, content=content)

    cache = ContentCache(tmp_path / "cache")
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        first = await acquire_source(
            source=source_record(),
            filename="counts.gz",
            workdir=create_task_workdir("task_4", base_dir=str(tmp_path / "tasks")),
            cache=cache,
            http=http,
            data_level=DataLevel.REPOSITORY_PROCESSED,
            max_bytes=1024,
        )
        second = await acquire_source(
            source=source_record(),
            filename="counts.gz",
            workdir=create_task_workdir("task_5", base_dir=str(tmp_path / "tasks")),
            cache=cache,
            http=http,
            data_level=DataLevel.REPOSITORY_PROCESSED,
            max_bytes=1024,
            expected_sha256=first.asset.sha256 if first.asset else None,
        )

    assert calls == 2
    assert first.asset is not None and second.asset is not None
    assert first.asset.asset_id == second.asset.asset_id
    assert cache.blob_path(first.asset.sha256).read_bytes() == content


@pytest.mark.asyncio
async def test_url_credentials_are_rejected_without_network(tmp_path: Path) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, content=b"should not run")

    unsafe = source_record().model_copy(
        update={"url": "https://user:password@ftp.ncbi.nlm.nih.gov/file.gz"}
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        result = await acquire_source(
            source=unsafe,
            filename="counts.gz",
            workdir=create_task_workdir("task_6", base_dir=str(tmp_path / "tasks")),
            cache=ContentCache(tmp_path / "cache"),
            http=http,
            data_level=DataLevel.REPOSITORY_PROCESSED,
            max_bytes=1024,
        )

    assert calls == 0
    assert result.attempt.status is DownloadStatus.FAILED
    assert result.asset is None
