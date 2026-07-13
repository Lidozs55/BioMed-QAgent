"""Tests for the browser_fallback skill — navigate_page and download_from_page."""
from __future__ import annotations

import asyncio
import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agents.tool_context import ToolContext

from app.agent_loop.context import RunContext
from app.skills.builtin.acquisition.browser import (
    download_from_page,
    navigate_page,
)


def _make_ctx(task_id: str = "test_browser") -> ToolContext:
    rc = RunContext(task_id=task_id)
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
    """navigate_page returns title, body_text_preview, and content_type on 200."""
    html = (
        "<html><head><title>Test Page</title></head>"
        "<body><p>Hello World</p></body></html>"
    )
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.headers = {"content-type": "text/html; charset=utf-8"}
    mock_response.text = html
    mock_response.content = html.encode("utf-8")

    mock_client = AsyncMock()
    mock_client.get.return_value = mock_response

    mock_cm = AsyncMock()
    mock_cm.__aenter__.return_value = mock_client

    ctx = _make_ctx()
    with patch(
        "app.skills.builtin.acquisition.browser.httpx.AsyncClient",
        return_value=mock_cm,
    ):
        args = json.dumps({"url": "https://example.com"})
        result = asyncio.run(navigate_page.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["url"] == "https://example.com"
    assert data["status_code"] == 200
    assert data["title"] == "Test Page"
    assert "Hello World" in data["body_text_preview"]
    assert "text/html" in data["content_type"]

    # log_query should record success
    rc: RunContext = ctx.context
    assert len(rc.query_log) == 1
    assert rc.query_log[0]["status"] == "succeeded"


def test_navigate_page_network_error_returns_error_json() -> None:
    """navigate_page returns error JSON (not raises) on network failure."""
    mock_cm = AsyncMock()
    mock_cm.__aenter__.side_effect = httpx_connect_error()

    ctx = _make_ctx()
    with patch(
        "app.skills.builtin.acquisition.browser.httpx.AsyncClient",
        return_value=mock_cm,
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


# ---------------------------------------------------------------------------
# download_from_page
# ---------------------------------------------------------------------------


def test_download_from_page_success() -> None:
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

    ctx = _make_ctx(task_id="test_browser_dl")
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

    # Verify provenance tracking
    rc: RunContext = ctx.context
    assert len(rc.raw_assets) == 1
    assert len(rc.sources) == 1
    assert rc.sources[0].source == "browser_fallback"
    assert rc.sources[0].accession == "test_data.pdf"
    # log_query should record success
    assert len(rc.query_log) == 1
    assert rc.query_log[0]["status"] == "succeeded"


def test_download_from_page_http_4xx_returns_error_json() -> None:
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

    ctx = _make_ctx(task_id="test_browser_404")
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
