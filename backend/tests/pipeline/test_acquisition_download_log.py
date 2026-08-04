from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
from app.domain.contracts import DownloadAttempt, DownloadStatus, TaskSpecification
from app.pipeline.stages import acquisition
from app.pipeline.stages.base import StageContext
from app.tools.workdir import create_task_workdir


def _context(
    tmp_path: Path,
    recorder: Callable[[DownloadAttempt], None] | None = None,
) -> StageContext:
    return StageContext(
        task_id="geo_live_fallback",
        workdir=create_task_workdir(
            "geo_live_fallback", base_dir=str(tmp_path / "tasks")
        ),
        fixture_dir=tmp_path,
        topic="fallback chain",
        started_at=datetime.now(UTC),
        mode="live",
        databases=["geo"],
        specification=TaskSpecification(topic="fallback chain"),
        download_attempt_recorder=recorder,
    )


def test_geo_live_fallback_records_failed_attempt_in_download_log(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """§1.5.2: a failed candidate URL must still appear in download_attempts.

    GEO live tries tximport counts first; when it 404s it falls back to the
    series matrix. Both attempts must be published so ``download_log.csv``
    shows the full fallback chain, not just the final success.
    """
    payload = b"gene_id\tS1\nTP53\t1.5\n"
    requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        if "_tximportCounts" in request.url.path:
            return httpx.Response(404)
        return httpx.Response(200, content=payload)

    real_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(acquisition.httpx, "AsyncClient", lambda: real_client)

    try:
        result = acquisition.run_acquisition(_context(tmp_path), datetime.now(UTC))
    finally:
        asyncio.run(real_client.aclose())

    output = result.output
    assert len(output.source_assets) == 1
    attempts = output.download_attempts
    # counts 404 (failed) + series matrix 200 (succeeded)
    assert len(attempts) == 2
    assert [attempt.status for attempt in attempts] == [
        DownloadStatus.FAILED,
        DownloadStatus.SUCCEEDED,
    ]
    assert attempts[0].error_message and "404" in attempts[0].error_message
    assert attempts[1].attempt_id == output.source_assets[0].successful_attempt_id
    assert any("_tximportCounts" in url for url in requests)
    assert any("_series_matrix" in url for url in requests)


def test_geo_live_all_failed_preserves_complete_attempt_chain(
    tmp_path: Path,
    monkeypatch,
) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(503)

    real_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(acquisition.httpx, "AsyncClient", lambda: real_client)
    attempts = []

    try:
        with pytest.raises(RuntimeError, match="all candidate URLs failed"):
            acquisition.run_acquisition(
                _context(tmp_path, attempts.append),
                datetime.now(UTC),
            )
    finally:
        asyncio.run(real_client.aclose())

    assert len(attempts) == 2
    assert all(
        attempt.status is DownloadStatus.FAILED
        for attempt in attempts
    )
    assert all(
        attempt.error_message and "503" in attempt.error_message
        for attempt in attempts
    )


def test_geo_live_counts_download_keeps_client_open_for_required_soft(
    tmp_path: Path,
    monkeypatch,
) -> None:
    requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        return httpx.Response(200, content=b"verified fixture bytes")

    real_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(acquisition.httpx, "AsyncClient", lambda: real_client)

    try:
        result = acquisition.run_acquisition(_context(tmp_path), datetime.now(UTC))
    finally:
        asyncio.run(real_client.aclose())

    output = result.output
    assert len(output.source_assets) == 2
    assert len(output.download_attempts) == 2
    assert all(
        attempt.status is DownloadStatus.SUCCEEDED
        for attempt in output.download_attempts
    )
    assert any("_tximportCounts" in url for url in requests)
    assert any("_family.soft.gz" in url for url in requests)


def test_geo_live_required_soft_failure_records_success_and_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if "_tximportCounts" in request.url.path:
            return httpx.Response(200, content=b"verified counts")
        return httpx.Response(503)

    real_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(acquisition.httpx, "AsyncClient", lambda: real_client)
    attempts: list[DownloadAttempt] = []

    try:
        with pytest.raises(RuntimeError, match="family SOFT required"):
            acquisition.run_acquisition(
                _context(tmp_path, attempts.append),
                datetime.now(UTC),
            )
    finally:
        asyncio.run(real_client.aclose())

    assert [attempt.status for attempt in attempts] == [
        DownloadStatus.SUCCEEDED,
        DownloadStatus.FAILED,
    ]
