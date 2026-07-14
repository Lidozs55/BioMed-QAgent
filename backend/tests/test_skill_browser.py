"""Tests for the browser_fallback skill — navigate_page and download_from_page."""
from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.skills.builtin.acquisition.browser import (
    download_from_page,
    navigate_page,
)
from app.tools.workdir import create_task_workdir


def _make_ctx(task_id: str = "test_browser", tmp_path: Path | None = None) -> ToolContext:
    rc = RunContext(task_id=task_id)
    if tmp_path is not None:
        rc._work_dir = create_task_workdir(task_id, base_dir=str(tmp_path))
    return ToolContext(
        context=rc,
        tool_name="navigate_page",
        tool_call_id="test_call_1",
        tool_arguments="{}",
    )


# ---------------------------------------------------------------------------
# navigate_page
# ---------------------------------------------------------------------------


def test_navigate_page_success() -> None:
    """navigate_page parses the rendered document returned by Playwright."""
    html = (
        "<html><head><title>Test Page</title></head>"
        "<body><p>Hello World</p></body></html>"
    )
    from app.tools.crawler import FetchResult

    rendered = FetchResult(
        url="https://example.com",
        content=html,
        status_code=200,
        elapsed_ms=12,
        method_used="crawl",
        headers={"content-type": "text/html; charset=utf-8"},
    )

    ctx = _make_ctx()
    with patch(
        "app.skills.builtin.acquisition.browser.playwright_fetch",
        return_value=rendered,
    ) as fetch:
        args = json.dumps({"url": "https://example.com"})
        result = asyncio.run(navigate_page.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["url"] == "https://example.com"
    assert data["status_code"] == 200
    assert data["method_used"] == "crawl"
    assert data["title"] == "Test Page"
    assert "Hello World" in data["body_text_preview"]
    assert "text/html" in data["content_type"]
    fetch.assert_called_once_with("https://example.com")

    # log_query should record success
    rc: RunContext = ctx.context
    assert len(rc.query_log) == 1
    assert rc.query_log[0]["status"] == "succeeded"


def test_navigate_page_network_error_returns_error_json() -> None:
    """navigate_page returns error JSON (not raises) on network failure."""
    ctx = _make_ctx()
    with patch(
        "app.skills.builtin.acquisition.browser.playwright_fetch",
        side_effect=httpx_connect_error(),
    ):
        args = json.dumps({"url": "https://unreachable.invalid"})
        result = asyncio.run(navigate_page.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["url"] == "https://unreachable.invalid"
    assert "error" in data
    assert "ConnectError" in data["error"] or "MockTransport" in data["error"]

    # log_query should record failure
    rc: RunContext = ctx.context
    assert len(rc.query_log) == 1
    assert rc.query_log[0]["status"] == "failed"


def test_navigate_page_failed_fetch_result_returns_error_json() -> None:
    """navigate_page must not turn crawler failures into empty success."""
    from app.tools.crawler import FetchResult

    failed = FetchResult(
        url="https://unreachable.invalid",
        content="",
        status_code=0,
        elapsed_ms=12,
        method_used="crawl",
        error="browser launch failed",
    )
    ctx = _make_ctx()

    with patch(
        "app.skills.builtin.acquisition.browser.playwright_fetch",
        return_value=failed,
    ):
        args = json.dumps({"url": "https://unreachable.invalid"})
        result = asyncio.run(navigate_page.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data == {
        "url": "https://unreachable.invalid",
        "status_code": 0,
        "method_used": "crawl",
        "error": "browser launch failed",
    }
    assert ctx.context.query_log[0]["status"] == "failed"


def test_navigate_page_keeps_event_loop_responsive() -> None:
    from app.tools.crawler import FetchResult

    loop_progressed = threading.Event()

    def blocking_fetch(url: str) -> FetchResult:
        assert loop_progressed.wait(timeout=0.5)
        return FetchResult(url, "<html></html>", 200, 1, "crawl")

    async def exercise() -> None:
        ctx = _make_ctx()
        task = asyncio.create_task(navigate_page.on_invoke_tool(
            ctx, json.dumps({"url": "https://example.com"})
        ))
        await asyncio.sleep(0)
        loop_progressed.set()
        result = await task
        assert "error" not in json.loads(result)

    with patch(
        "app.skills.builtin.acquisition.browser.playwright_fetch",
        side_effect=blocking_fetch,
    ):
        asyncio.run(exercise())


# ---------------------------------------------------------------------------
# download_from_page
# ---------------------------------------------------------------------------


def test_download_from_page_success(tmp_path: Path) -> None:
    """download_from_page saves file, tracks provenance, and logs query."""
    file_content = b"fake file content for testing"

    mock_resp = AsyncMock()
    mock_resp.status_code = 200
    mock_resp.headers = {"content-type": "application/pdf"}
    mock_resp.aiter_bytes = _make_aiter_bytes([file_content])

    mock_stream_cm = AsyncMock()
    mock_stream_cm.__aenter__.return_value = mock_resp

    # client.stream() is NOT async — it returns an async context manager synchronously
    mock_client = MagicMock()
    mock_client.stream.return_value = mock_stream_cm

    mock_client_cm = AsyncMock()
    mock_client_cm.__aenter__.return_value = mock_client

    ctx = _make_ctx(task_id="test_browser_dl", tmp_path=tmp_path)
    with patch(
        "app.skills.builtin.acquisition.browser.httpx.AsyncClient",
        return_value=mock_client_cm,
    ):
        args = json.dumps({
            "url": "https://example.com/data.pdf",
            "filename": "test_data.pdf",
        })
        result = asyncio.run(download_from_page.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "browser_fallback"
    assert data["source_url"] == "https://example.com/data.pdf"
    assert data["bytes_received"] == len(file_content)
    assert "application/pdf" in data["mime_type"]
    assert len(data["local_files"]) == 1
    assert data["local_files"][0].endswith("test_data.pdf")
    rc: RunContext = ctx.context
    assert rc.work_dir.source_asset_file("test_data.pdf").read_bytes() == file_content
    assert list(rc.work_dir.download_tmp.iterdir()) == []

    # Verify provenance tracking
    assert len(rc.raw_assets) == 1
    assert len(rc.sources) == 1
    assert rc.sources[0].database.value == "browser"
    assert rc.sources[0].accession == "test_data.pdf"
    # log_query should record success
    assert len(rc.query_log) == 1
    assert rc.query_log[0]["status"] == "succeeded"


def test_download_from_page_http_4xx_returns_error_json(tmp_path: Path) -> None:
    """download_from_page returns error JSON on HTTP 4xx (not raises)."""
    mock_resp = AsyncMock()
    mock_resp.status_code = 404
    mock_resp.headers = {"content-type": "text/html"}
    mock_resp.aiter_bytes = _make_aiter_bytes([b"Not Found"])

    mock_stream_cm = AsyncMock()
    mock_stream_cm.__aenter__.return_value = mock_resp

    # client.stream() is NOT async — it returns an async context manager synchronously
    mock_client = MagicMock()
    mock_client.stream.return_value = mock_stream_cm

    mock_client_cm = AsyncMock()
    mock_client_cm.__aenter__.return_value = mock_client

    ctx = _make_ctx(task_id="test_browser_404", tmp_path=tmp_path)
    with patch(
        "app.skills.builtin.acquisition.browser.httpx.AsyncClient",
        return_value=mock_client_cm,
    ):
        args = json.dumps({
            "url": "https://example.com/missing.pdf",
            "filename": "missing.pdf",
        })
        result = asyncio.run(download_from_page.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "browser_fallback"
    assert data["accession"] == "missing.pdf"
    assert "error" in data
    assert "404" in data["error"]

    # log_query should record failure
    rc: RunContext = ctx.context
    assert len(rc.query_log) == 1
    assert rc.query_log[0]["status"] == "failed"
    # No raw assets or sources for failed download
    assert len(rc.raw_assets) == 0
    assert len(rc.sources) == 0
    assert list(rc.work_dir.download_tmp.iterdir()) == []
    assert list(rc.work_dir.source_assets.iterdir()) == []


def test_download_rejects_filename_traversal_before_streaming(tmp_path: Path) -> None:
    mock_client = MagicMock()
    mock_client_cm = AsyncMock()
    mock_client_cm.__aenter__.return_value = mock_client
    ctx = _make_ctx(task_id="test_browser_traversal", tmp_path=tmp_path)

    with patch(
        "app.skills.builtin.acquisition.browser.httpx.AsyncClient",
        return_value=mock_client_cm,
    ):
        result = asyncio.run(download_from_page.on_invoke_tool(
            ctx,
            json.dumps({"url": "https://example.com/data", "filename": "../escape.bin"}),
        ))

    assert "error" in json.loads(result)
    mock_client.stream.assert_not_called()


def test_download_stream_exception_removes_partial_file(tmp_path: Path) -> None:
    async def broken_stream():
        yield b"partial"
        raise RuntimeError("stream interrupted")

    mock_resp = AsyncMock()
    mock_resp.status_code = 200
    mock_resp.headers = {"content-type": "application/octet-stream"}
    mock_resp.aiter_bytes = broken_stream
    mock_stream_cm = AsyncMock()
    mock_stream_cm.__aenter__.return_value = mock_resp
    mock_client = MagicMock()
    mock_client.stream.return_value = mock_stream_cm
    mock_client_cm = AsyncMock()
    mock_client_cm.__aenter__.return_value = mock_client
    ctx = _make_ctx(task_id="test_browser_partial", tmp_path=tmp_path)

    with patch(
        "app.skills.builtin.acquisition.browser.httpx.AsyncClient",
        return_value=mock_client_cm,
    ):
        result = asyncio.run(download_from_page.on_invoke_tool(
            ctx,
            json.dumps({"url": "https://example.com/data", "filename": "data.bin"}),
        ))

    assert "stream interrupted" in json.loads(result)["error"]
    assert list(ctx.context.work_dir.download_tmp.iterdir()) == []
    assert list(ctx.context.work_dir.source_assets.iterdir()) == []


def test_download_cancellation_removes_partial_file(tmp_path: Path) -> None:
    async def exercise() -> tuple[list[Path], list[Path]]:
        partial_written = asyncio.Event()

        async def cancellable_stream():
            yield b"partial"
            partial_written.set()
            await asyncio.Event().wait()

        mock_resp = AsyncMock()
        mock_resp.status_code = 200
        mock_resp.headers = {"content-type": "application/octet-stream"}
        mock_resp.aiter_bytes = cancellable_stream
        mock_stream_cm = AsyncMock()
        mock_stream_cm.__aenter__.return_value = mock_resp
        mock_client = MagicMock()
        mock_client.stream.return_value = mock_stream_cm
        mock_client_cm = AsyncMock()
        mock_client_cm.__aenter__.return_value = mock_client
        ctx = _make_ctx(task_id="test_browser_cancel", tmp_path=tmp_path)

        with (
            patch(
                "app.skills.builtin.acquisition.browser._rate_limiter.wait",
                return_value=None,
            ),
            patch(
                "app.skills.builtin.acquisition.browser.httpx.AsyncClient",
                return_value=mock_client_cm,
            ),
        ):
            task = asyncio.create_task(download_from_page.on_invoke_tool(
                ctx,
                json.dumps({
                    "url": "https://example.com/data",
                    "filename": "data.bin",
                }),
            ))
            await partial_written.wait()
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            else:
                raise AssertionError("cancelled download must propagate cancellation")

        return (
            list(ctx.context.work_dir.download_tmp.iterdir()),
            list(ctx.context.work_dir.source_assets.iterdir()),
        )

    partials, assets = asyncio.run(exercise())

    assert partials == []
    assert assets == []


def test_download_does_not_overwrite_existing_asset(tmp_path: Path) -> None:
    ctx = _make_ctx(task_id="test_browser_existing", tmp_path=tmp_path)
    existing = ctx.context.work_dir.source_asset_file("data.bin")
    existing.write_bytes(b"original")
    mock_client = MagicMock()
    mock_client_cm = AsyncMock()
    mock_client_cm.__aenter__.return_value = mock_client

    with patch(
        "app.skills.builtin.acquisition.browser.httpx.AsyncClient",
        return_value=mock_client_cm,
    ):
        result = asyncio.run(download_from_page.on_invoke_tool(
            ctx,
            json.dumps({"url": "https://example.com/data", "filename": "data.bin"}),
        ))

    assert "error" in json.loads(result)
    assert existing.read_bytes() == b"original"
    mock_client.stream.assert_not_called()


def test_download_publication_is_atomic_and_no_clobber(tmp_path: Path) -> None:
    from app.skills.builtin.acquisition import browser

    temp = tmp_path / "complete.part"
    destination = tmp_path / "asset.bin"
    temp.write_bytes(b"complete download")
    destination.write_bytes(b"competing writer")

    try:
        browser._publish_no_clobber(temp, destination)
    except FileExistsError:
        pass
    else:
        raise AssertionError("publication must reject an existing destination")

    assert destination.read_bytes() == b"competing writer"
    assert not temp.exists()


def test_concurrent_same_filename_downloads_publish_immutable_winner(
    tmp_path: Path,
) -> None:
    async def exercise() -> tuple[list[dict], bytes, list[Path]]:
        first_writer_paused = asyncio.Event()
        winner_published = asyncio.Event()

        async def losing_bytes():
            yield b"loser-start"
            first_writer_paused.set()
            await winner_published.wait()
            yield b"-late-mutation"

        async def winning_bytes():
            yield b"winner"

        responses = []
        for iterator in (losing_bytes, winning_bytes):
            response = AsyncMock()
            response.status_code = 200
            response.headers = {"content-type": "application/octet-stream"}
            response.aiter_bytes = iterator
            stream_cm = AsyncMock()
            stream_cm.__aenter__.return_value = response
            client = MagicMock()
            client.stream.return_value = stream_cm
            client_cm = AsyncMock()
            client_cm.__aenter__.return_value = client
            responses.append(client_cm)

        ctx = _make_ctx(task_id="same_filename_race", tmp_path=tmp_path)
        args = json.dumps({
            "url": "https://example.com/data",
            "filename": "shared.bin",
        })

        async def run_winner() -> str:
            await first_writer_paused.wait()
            result = await download_from_page.on_invoke_tool(ctx, args)
            winner_published.set()
            return result

        with (
            patch(
                "app.skills.builtin.acquisition.browser._rate_limiter.wait",
                return_value=None,
            ),
            patch(
                "app.skills.builtin.acquisition.browser.httpx.AsyncClient",
                side_effect=responses,
            ),
        ):
            loser_task = asyncio.create_task(download_from_page.on_invoke_tool(ctx, args))
            winner_task = asyncio.create_task(run_winner())
            raw_results = await asyncio.gather(loser_task, winner_task)

        destination = ctx.context.work_dir.source_asset_file("shared.bin")
        return (
            [json.loads(result) for result in raw_results],
            destination.read_bytes(),
            list(ctx.context.work_dir.download_tmp.iterdir()),
        )

    results, final_bytes, leftovers = asyncio.run(exercise())

    assert sum("error" not in result for result in results) == 1
    assert final_bytes == b"winner"
    assert leftovers == []


def test_download_rate_limit_keeps_event_loop_responsive(tmp_path: Path) -> None:
    loop_progressed = threading.Event()
    wait_observed_progress = False

    def blocking_wait() -> None:
        nonlocal wait_observed_progress
        wait_observed_progress = loop_progressed.wait(timeout=0.5)

    mock_resp = AsyncMock(status_code=404, headers={"content-type": "text/html"})
    mock_stream_cm = AsyncMock()
    mock_stream_cm.__aenter__.return_value = mock_resp
    mock_client = MagicMock()
    mock_client.stream.return_value = mock_stream_cm
    mock_client_cm = AsyncMock()
    mock_client_cm.__aenter__.return_value = mock_client

    async def exercise() -> None:
        ctx = _make_ctx(task_id="responsive_download", tmp_path=tmp_path)
        task = asyncio.create_task(download_from_page.on_invoke_tool(
            ctx,
            json.dumps({"url": "https://example.com/data", "filename": "data.bin"}),
        ))
        await asyncio.sleep(0)
        loop_progressed.set()
        await task

    with (
        patch(
            "app.skills.builtin.acquisition.browser._rate_limiter.wait",
            side_effect=blocking_wait,
        ),
        patch(
            "app.skills.builtin.acquisition.browser.httpx.AsyncClient",
            return_value=mock_client_cm,
        ),
    ):
        asyncio.run(exercise())

    assert wait_observed_progress


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def httpx_connect_error() -> Exception:
    """Return an httpx.ConnectError for mocking network failures."""
    import httpx
    return httpx.ConnectError("MockTransport connection failed")


def _make_aiter_bytes(chunks: list[bytes]):
    """Create an async iterator over byte chunks for mock responses."""
    async def _aiter():
        for chunk in chunks:
            yield chunk
    return _aiter
