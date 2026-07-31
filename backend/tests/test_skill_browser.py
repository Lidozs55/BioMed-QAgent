"""Tests for the browser_fallback skill through the Run-bound crawler facade."""

from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
from unittest.mock import AsyncMock, Mock

import pytest
from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.skills.builtin.acquisition.browser import download_from_page, navigate_page
from app.tools.crawler import DownloadResult, FetchResult
from app.tools.workdir import create_task_workdir


def _make_ctx(
    *,
    facade: Mock,
    task_id: str = "test_browser",
    tmp_path: Path | None = None,
) -> ToolContext:
    run_context = RunContext(task_id=task_id)
    if tmp_path is not None:
        run_context._work_dir = create_task_workdir(task_id, base_dir=str(tmp_path))
    run_context.bind_crawler_facade(facade)
    return ToolContext(
        context=run_context,
        tool_name="navigate_page",
        tool_call_id="test_call_1",
        tool_arguments="{}",
    )


def _facade() -> Mock:
    facade = Mock()
    facade.browser = AsyncMock()
    facade.download = AsyncMock()
    return facade


def test_navigate_page_uses_bound_browser_pool_and_parses_rendered_html() -> None:
    facade = _facade()
    facade.browser.return_value = FetchResult(
        url="https://example.com",
        content=(
            "<html><head><title>Test Page</title></head><body><p>Hello World</p></body></html>"
        ),
        status_code=200,
        elapsed_ms=12,
        method_used="crawl",
        headers={"content-type": "text/html; charset=utf-8"},
    )
    context = _make_ctx(facade=facade)

    result = asyncio.run(
        navigate_page.on_invoke_tool(
            context,
            json.dumps({"url": "https://example.com"}),
        )
    )

    data = json.loads(result)
    assert data["title"] == "Test Page"
    assert "Hello World" in data["body_text_preview"]
    facade.browser.assert_awaited_once_with("https://example.com")
    assert context.context.query_log[0]["status"] == "success"


def test_navigate_page_returns_crawler_failure_as_error_json() -> None:
    facade = _facade()
    facade.browser.return_value = FetchResult(
        url="https://unreachable.invalid",
        content="",
        status_code=0,
        elapsed_ms=12,
        method_used="crawl",
        error="browser launch failed",
    )
    context = _make_ctx(facade=facade)

    result = asyncio.run(
        navigate_page.on_invoke_tool(
            context,
            json.dumps({"url": "https://unreachable.invalid"}),
        )
    )

    assert json.loads(result)["error"] == "browser launch failed"
    assert context.context.query_log[0]["status"] == "failed"


def test_download_from_page_uses_bounded_facade_and_tracks_provenance(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    thread_calls: list[str] = []
    original_to_thread = asyncio.to_thread

    async def tracked_to_thread(
        function: object,
        /,
        *args: object,
        **kwargs: object,
    ) -> object:
        thread_calls.append(getattr(function, "__name__", type(function).__name__))
        return await original_to_thread(function, *args, **kwargs)

    monkeypatch.setattr(asyncio, "to_thread", tracked_to_thread)
    facade = _facade()
    facade.download.return_value = DownloadResult(
        url="https://example.com/data.pdf",
        content=b"fake pdf",
        status_code=200,
        elapsed_ms=4,
        headers={"content-type": "application/pdf"},
    )
    context = _make_ctx(
        facade=facade,
        task_id="test_browser_dl",
        tmp_path=tmp_path,
    )

    result = asyncio.run(
        download_from_page.on_invoke_tool(
            context,
            json.dumps(
                {
                    "url": "https://example.com/data.pdf",
                    "filename": "test_data.pdf",
                }
            ),
        )
    )

    data = json.loads(result)
    assert data["bytes_received"] == len(b"fake pdf")
    expected_sha256 = hashlib.sha256(b"fake pdf").hexdigest()
    source_asset = data["source_asset"]
    download_attempt = data["download_attempt"]
    committed_path = context.context.work_dir.root / source_asset["relative_path"]
    assert committed_path.read_bytes() == b"fake pdf"
    assert source_asset["sha256"] == expected_sha256
    assert source_asset["asset_id"] == f"asset_{expected_sha256}"
    assert source_asset["successful_attempt_id"] == download_attempt["attempt_id"]
    assert download_attempt["source_id"] == source_asset["source_id"]
    assert download_attempt["bytes_received"] == len(b"fake pdf")
    assert download_attempt["status"] == "succeeded"
    assert thread_calls == [
        "stage_bytes",
        "validate_source_asset",
        "commit_source_asset",
    ]
    assert not any(context.context.work_dir.staging.rglob("*.pdf"))
    assert context.context.sources[0].database.value == "browser"
    assert context.context.query_log[0]["status"] == "success"
    facade.download.assert_awaited_once_with("https://example.com/data.pdf")


def test_child_download_from_page_uses_exact_child_staging_boundary(
    tmp_path: Path,
) -> None:
    facade = _facade()
    facade.download.return_value = DownloadResult(
        url="https://example.com/data.pdf",
        content=b"child pdf",
        status_code=200,
        elapsed_ms=4,
        headers={"content-type": "application/pdf"},
    )
    parent = RunContext(task_id="test_child_browser_dl", base_dir=tmp_path)
    child = parent.create_child_context("child-browser")
    child.bind_crawler_facade(facade)
    context = ToolContext(
        context=child,
        tool_name="download_from_page",
        tool_call_id="child-call",
        tool_arguments="{}",
    )

    result = asyncio.run(
        download_from_page.on_invoke_tool(
            context,
            json.dumps(
                {
                    "url": "https://example.com/data.pdf",
                    "filename": "child.pdf",
                }
            ),
        )
    )

    data = json.loads(result)
    committed = Path(data["local_files"][0])
    assert committed.is_relative_to(parent.work_dir.source_assets)
    assert committed.read_bytes() == b"child pdf"
    assert child.source_asset_ids == [data["source_asset"]["asset_id"]]


def test_download_failure_does_not_publish_partial_asset(tmp_path: Path) -> None:
    facade = _facade()
    facade.download.return_value = DownloadResult(
        url="https://example.com/missing.pdf",
        content=b"",
        status_code=404,
        elapsed_ms=4,
        headers={"content-type": "text/html"},
        error="HTTP 404",
    )
    context = _make_ctx(
        facade=facade,
        task_id="test_browser_404",
        tmp_path=tmp_path,
    )

    result = asyncio.run(
        download_from_page.on_invoke_tool(
            context,
            json.dumps(
                {
                    "url": "https://example.com/missing.pdf",
                    "filename": "missing.pdf",
                }
            ),
        )
    )

    assert "404" in json.loads(result)["error"]
    assert list(context.context.work_dir.download_tmp.iterdir()) == []
    assert list(context.context.work_dir.source_assets.iterdir()) == []


def test_download_rejects_unsafe_or_existing_filename_before_transport(
    tmp_path: Path,
) -> None:
    facade = _facade()
    traversal = _make_ctx(
        facade=facade,
        task_id="test_browser_traversal",
        tmp_path=tmp_path,
    )
    traversal_result = asyncio.run(
        download_from_page.on_invoke_tool(
            traversal,
            json.dumps(
                {
                    "url": "https://example.com/data",
                    "filename": "../escape.bin",
                }
            ),
        )
    )

    existing_context = _make_ctx(
        facade=facade,
        task_id="test_browser_existing",
        tmp_path=tmp_path,
    )
    existing = existing_context.context.work_dir.source_asset_file("data.bin")
    existing.write_bytes(b"original")
    existing_result = asyncio.run(
        download_from_page.on_invoke_tool(
            existing_context,
            json.dumps(
                {
                    "url": "https://example.com/data",
                    "filename": "data.bin",
                }
            ),
        )
    )

    assert "error" in json.loads(traversal_result)
    assert "error" in json.loads(existing_result)
    assert existing.read_bytes() == b"original"
    facade.download.assert_not_awaited()
