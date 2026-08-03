from __future__ import annotations

import asyncio
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
    asset_id_from_sha256,
)
from app.integrations import acquisition
from app.integrations.acquisition import acquire_source
from app.tools.content_cache import ContentCache
from app.tools.workdir import create_task_workdir

NOW = datetime(2026, 7, 12, tzinfo=UTC)
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


class FailingStream(httpx.AsyncByteStream):
    def __init__(self, error: Exception) -> None:
        self.error = error

    async def __aiter__(self):
        yield b"partial"
        raise self.error

    async def aclose(self) -> None:
        return None


class BlockingStream(httpx.AsyncByteStream):
    def __init__(self, started: asyncio.Event) -> None:
        self.started = started
        self.blocker = asyncio.Event()

    async def __aiter__(self):
        yield b"partial"
        self.started.set()
        await self.blocker.wait()

    async def aclose(self) -> None:
        return None


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

    # Request-level cache: second call skips the network entirely.
    assert calls == 1
    assert first.asset is not None and second.asset is not None
    assert first.asset.asset_id == second.asset.asset_id
    assert cache.blob_path(first.asset.sha256).read_bytes() == content


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("constraints", "expected_code"),
    [
        ({"max_bytes": 4}, ErrorCode.DOWNLOAD_INCOMPLETE),
        ({"expected_size": 999}, ErrorCode.DOWNLOAD_INCOMPLETE),
        ({"expected_sha256": "aa" * 32}, ErrorCode.CHECKSUM_MISMATCH),
        (
            {"expected_media_types": frozenset({"application/json"})},
            ErrorCode.VALIDATION_ERROR,
        ),
    ],
)
async def test_request_cache_hit_revalidates_current_constraints(
    tmp_path: Path,
    constraints: dict[str, object],
    expected_code: ErrorCode,
) -> None:
    """A cached blob is reusable only when it satisfies this invocation."""
    content = b"cached tabular content"
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(
            200,
            content=content,
            headers={"Content-Type": "text/tab-separated-values"},
        )

    cache = ContentCache(tmp_path / "cache")
    second_options: dict[str, object] = {"max_bytes": 1024}
    second_options.update(constraints)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        first = await acquire_source(
            source=source_record(),
            filename="counts.tsv",
            workdir=create_task_workdir(
                "task_cache_seed", base_dir=str(tmp_path / "tasks")
            ),
            cache=cache,
            http=http,
            data_level=DataLevel.REPOSITORY_PROCESSED,
            max_bytes=1024,
        )
        second = await acquire_source(
            source=source_record(),
            filename="counts.tsv",
            workdir=create_task_workdir(
                f"task_cache_{expected_code.value}",
                base_dir=str(tmp_path / "tasks"),
            ),
            cache=cache,
            http=http,
            data_level=DataLevel.REPOSITORY_PROCESSED,
            **second_options,
        )

    assert first.asset is not None
    assert calls == 1
    assert second.asset is None
    assert second.attempt.status is DownloadStatus.FAILED
    assert second.attempt.error_code is expected_code


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


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error", "expected_code"),
    [
        (httpx.ReadError("connection dropped"), ErrorCode.NETWORK_ERROR),
        (httpx.ReadTimeout("read timed out"), ErrorCode.TIMEOUT),
    ],
)
async def test_interrupted_stream_never_publishes_source_asset(
    tmp_path: Path,
    error: Exception,
    expected_code: ErrorCode,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=FailingStream(error))

    workdir = create_task_workdir("task_interrupted", base_dir=str(tmp_path / "tasks"))
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        result = await acquire_source(
            source=source_record(),
            filename="counts.gz",
            workdir=workdir,
            cache=ContentCache(tmp_path / "cache"),
            http=http,
            data_level=DataLevel.REPOSITORY_PROCESSED,
            max_bytes=1024,
        )

    assert result.attempt.status is DownloadStatus.FAILED
    assert result.attempt.error_code is expected_code
    assert result.asset is None
    assert list(workdir.source_assets.rglob("*")) == []
    assert list(workdir.download_tmp.iterdir()) == []


@pytest.mark.asyncio
async def test_cancelled_stream_cleans_partial_file_without_publishing_asset(
    tmp_path: Path,
) -> None:
    started = asyncio.Event()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=BlockingStream(started))

    workdir = create_task_workdir("task_cancelled", base_dir=str(tmp_path / "tasks"))
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        task = asyncio.create_task(
            acquire_source(
                source=source_record(),
                filename="counts.gz",
                workdir=workdir,
                cache=ContentCache(tmp_path / "cache"),
                http=http,
                data_level=DataLevel.REPOSITORY_PROCESSED,
                max_bytes=1024,
            )
        )
        await asyncio.wait_for(started.wait(), timeout=1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    assert list(workdir.source_assets.rglob("*")) == []
    assert list(workdir.download_tmp.iterdir()) == []


@pytest.mark.asyncio
async def test_same_host_https_redirects_are_followed(tmp_path: Path) -> None:
    requested_urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested_urls.append(str(request.url))
        if request.url.path.endswith("txt.gz"):
            return httpx.Response(302, headers={"Location": "/redirect/one"})
        if request.url.path == "/redirect/one":
            return httpx.Response(307, headers={"Location": "two"})
        return httpx.Response(200, content=b"redirected content")

    workdir = create_task_workdir("task_redirect", base_dir=str(tmp_path / "tasks"))
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        result = await acquire_source(
            source=source_record(),
            filename="counts.gz",
            workdir=workdir,
            cache=ContentCache(tmp_path / "cache"),
            http=http,
            data_level=DataLevel.REPOSITORY_PROCESSED,
            max_bytes=1024,
        )

    assert result.attempt.status is DownloadStatus.SUCCEEDED
    assert result.asset is not None
    assert requested_urls == [
        URL,
        "https://ftp.ncbi.nlm.nih.gov/redirect/one",
        "https://ftp.ncbi.nlm.nih.gov/redirect/two",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "unsafe_location",
    [
        "https://www.ncbi.nlm.nih.gov/file.gz",
        "https://user:secret@ftp.ncbi.nlm.nih.gov/file.gz",
        "http://ftp.ncbi.nlm.nih.gov/file.gz",
    ],
)
async def test_unsafe_redirect_target_is_rejected_before_request(
    tmp_path: Path,
    unsafe_location: str,
) -> None:
    requested_urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested_urls.append(str(request.url))
        if len(requested_urls) == 1:
            return httpx.Response(302, headers={"Location": "/safe-hop"})
        return httpx.Response(302, headers={"Location": unsafe_location})

    workdir = create_task_workdir(
        "task_unsafe_redirect", base_dir=str(tmp_path / "tasks")
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        result = await acquire_source(
            source=source_record(),
            filename="counts.gz",
            workdir=workdir,
            cache=ContentCache(tmp_path / "cache"),
            http=http,
            data_level=DataLevel.REPOSITORY_PROCESSED,
            max_bytes=1024,
        )

    assert len(requested_urls) == 2
    assert result.attempt.status is DownloadStatus.FAILED
    assert result.attempt.error_code is ErrorCode.VALIDATION_ERROR
    assert result.asset is None
    assert list(workdir.source_assets.rglob("*")) == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("content", "headers"),
    [
        (b"short", {"Content-Length": "10"}),
        (b"", {}),
    ],
)
async def test_incomplete_or_empty_response_is_rejected(
    tmp_path: Path,
    content: bytes,
    headers: dict[str, str],
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=content, headers=headers)

    workdir = create_task_workdir("task_incomplete", base_dir=str(tmp_path / "tasks"))
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        result = await acquire_source(
            source=source_record(),
            filename="counts.gz",
            workdir=workdir,
            cache=ContentCache(tmp_path / "cache"),
            http=http,
            data_level=DataLevel.REPOSITORY_PROCESSED,
            max_bytes=1024,
        )

    assert result.attempt.status is DownloadStatus.FAILED
    assert result.attempt.error_code is ErrorCode.DOWNLOAD_INCOMPLETE
    assert result.asset is None
    assert list(workdir.source_assets.rglob("*")) == []


@pytest.mark.asyncio
async def test_corrupt_existing_cache_blob_is_rejected(tmp_path: Path) -> None:
    content = b"verified content"
    checksum = hashlib.sha256(content).hexdigest()
    cache = ContentCache(tmp_path / "cache")
    cache.blob_path(checksum).write_bytes(b"corrupt")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=content)

    workdir = create_task_workdir(
        "task_corrupt_cache", base_dir=str(tmp_path / "tasks")
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        result = await acquire_source(
            source=source_record(),
            filename="counts.gz",
            workdir=workdir,
            cache=cache,
            http=http,
            data_level=DataLevel.REPOSITORY_PROCESSED,
            max_bytes=1024,
        )

    assert result.attempt.status is DownloadStatus.FAILED
    assert result.attempt.error_code is ErrorCode.CHECKSUM_MISMATCH
    assert result.asset is None
    assert cache.blob_path(checksum).read_bytes() == b"corrupt"
    assert list(workdir.source_assets.rglob("*")) == []


@pytest.mark.asyncio
async def test_copy_fallback_verifies_temp_then_atomically_renames(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    content = b"copy fallback content"
    checksum = hashlib.sha256(content).hexdigest()
    cache = ContentCache(tmp_path / "cache")
    cache.blob_path(checksum).write_bytes(content)
    replace_calls: list[tuple[Path, Path]] = []
    real_replace = acquisition.os.replace

    def fail_link(source: Path, destination: Path) -> None:
        raise OSError("hard links unavailable")

    def record_replace(source: Path, destination: Path) -> None:
        source_path = Path(source)
        destination_path = Path(destination)
        assert source_path.exists()
        assert not destination_path.exists()
        replace_calls.append((source_path, destination_path))
        real_replace(source_path, destination_path)

    monkeypatch.setattr(acquisition.os, "link", fail_link)
    monkeypatch.setattr(acquisition.os, "replace", record_replace)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=content)

    workdir = create_task_workdir(
        "task_copy_fallback", base_dir=str(tmp_path / "tasks")
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        result = await acquire_source(
            source=source_record(),
            filename="counts.gz",
            workdir=workdir,
            cache=cache,
            http=http,
            data_level=DataLevel.REPOSITORY_PROCESSED,
            max_bytes=1024,
        )

    assert result.attempt.status is DownloadStatus.SUCCEEDED
    assert result.asset is not None
    destination = workdir.root / result.asset.relative_path
    assert replace_calls == [(replace_calls[0][0], destination)]
    assert replace_calls[0][0] != destination
    assert not replace_calls[0][0].exists()
    assert destination.read_bytes() == content


@pytest.mark.asyncio
async def test_copy_fallback_rejects_corrupt_temp_without_destination(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    content = b"copy fallback content"
    checksum = hashlib.sha256(content).hexdigest()
    cache = ContentCache(tmp_path / "cache")
    cache.blob_path(checksum).write_bytes(content)

    def fail_link(source: Path, destination: Path) -> None:
        raise OSError("hard links unavailable")

    def corrupt_copy(source, target, length: int) -> None:
        target.write(b"corrupt")

    monkeypatch.setattr(acquisition.os, "link", fail_link)
    monkeypatch.setattr(acquisition.shutil, "copyfileobj", corrupt_copy)

    workdir = create_task_workdir("task_corrupt_copy", base_dir=str(tmp_path / "tasks"))
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, content=content)
        )
    ) as http:
        result = await acquire_source(
            source=source_record(),
            filename="counts.gz",
            workdir=workdir,
            cache=cache,
            http=http,
            data_level=DataLevel.REPOSITORY_PROCESSED,
            max_bytes=1024,
        )

    assert result.attempt.status is DownloadStatus.FAILED
    assert result.attempt.error_code is ErrorCode.CHECKSUM_MISMATCH
    assert result.asset is None
    assert list(workdir.source_assets.rglob("*")) == []


@pytest.mark.asyncio
async def test_existing_task_asset_is_idempotent_only_for_same_content(
    tmp_path: Path,
) -> None:
    content = b"stable content"
    checksum = hashlib.sha256(content).hexdigest()
    asset_id = asset_id_from_sha256(checksum)
    workdir = create_task_workdir("task_existing", base_dir=str(tmp_path / "tasks"))
    destination = workdir.source_assets / asset_id / "counts.gz"
    destination.parent.mkdir(parents=True)
    destination.write_bytes(content)

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, content=content)
        )
    ) as http:
        same = await acquire_source(
            source=source_record(),
            filename="counts.gz",
            workdir=workdir,
            cache=ContentCache(tmp_path / "cache"),
            http=http,
            data_level=DataLevel.REPOSITORY_PROCESSED,
            max_bytes=1024,
        )

    assert same.attempt.status is DownloadStatus.SUCCEEDED
    assert same.asset is not None
    assert destination.read_bytes() == content

    destination.write_bytes(b"different")
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, content=content)
        )
    ) as http:
        different = await acquire_source(
            source=source_record(),
            filename="counts.gz",
            workdir=workdir,
            cache=ContentCache(tmp_path / "cache"),
            http=http,
            data_level=DataLevel.REPOSITORY_PROCESSED,
            max_bytes=1024,
        )

    assert different.attempt.status is DownloadStatus.FAILED
    assert different.attempt.error_code is ErrorCode.CHECKSUM_MISMATCH
    assert different.asset is None
    assert destination.read_bytes() == b"different"


@pytest.mark.asyncio
async def test_request_level_cache_skips_network_on_second_call(
    tmp_path: Path,
) -> None:
    """Request-level metadata cache skips the network on the second call."""
    content = b"cached content for request-level test"
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
            workdir=create_task_workdir("task_req1", base_dir=str(tmp_path / "tasks")),
            cache=cache,
            http=http,
            data_level=DataLevel.REPOSITORY_PROCESSED,
            max_bytes=1024,
        )
        # Different source_id but same (database, accession, url) → cache hit
        other_source = source_record().model_copy(
            update={"source_id": "src_geo_other"}
        )
        second = await acquire_source(
            source=other_source,
            filename="counts.gz",
            workdir=create_task_workdir("task_req2", base_dir=str(tmp_path / "tasks")),
            cache=cache,
            http=http,
            data_level=DataLevel.REPOSITORY_PROCESSED,
            max_bytes=1024,
        )

    assert calls == 1
    assert first.asset is not None and second.asset is not None
    assert first.asset.sha256 == second.asset.sha256
    assert first.asset.asset_id == second.asset.asset_id
    assert second.attempt.status is DownloadStatus.SUCCEEDED
    # The second source_id should be reflected in the asset
    assert second.asset.source_id == "src_geo_other"


def test_canonical_request_hash_is_deterministic() -> None:
    """Same (database, accession, url) always produces the same hash."""
    from app.tools.content_cache import canonical_request_hash

    h1 = canonical_request_hash("geo", "GSE178352", "https://example.test/file.gz")
    h2 = canonical_request_hash("GEO", "gse178352", "https://example.test/file.gz")
    assert h1 == h2
    assert len(h1) == 64

    h3 = canonical_request_hash("geo", "GSE999999", "https://example.test/file.gz")
    assert h1 != h3


def test_read_write_metadata_roundtrip(tmp_path: Path) -> None:
    """Metadata written and read back should match."""
    cache = ContentCache(tmp_path / "cache")
    req_hash = "ab" * 32
    metadata = {
        "sha256": "cd" * 32,
        "size_bytes": "1024",
        "media_type": "application/gzip",
    }
    cache.write_metadata(req_hash, metadata)
    result = cache.read_metadata(req_hash)
    assert result is not None
    assert result["sha256"] == metadata["sha256"]
    assert result["size_bytes"] == "1024"


def test_read_metadata_returns_none_when_absent(tmp_path: Path) -> None:
    """Reading metadata for a non-existent request should return None."""
    cache = ContentCache(tmp_path / "cache")
    assert cache.read_metadata("ab" * 32) is None
