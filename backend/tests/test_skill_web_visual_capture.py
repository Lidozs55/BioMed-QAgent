"""Tests for web visual capture through BrowserPool staging."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, Mock

from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.skills.builtin.acquisition.web_visual_capture import (
    capture_page_section,
    capture_web_page,
)
from app.tools.browser_pool import BrowserScreenshotResult
from app.tools.workdir import create_task_workdir


def _make_ctx(
    *,
    facade: Mock,
    task_id: str,
    tmp_path: Path,
) -> ToolContext:
    run_context = RunContext(task_id=task_id)
    run_context._work_dir = create_task_workdir(task_id, base_dir=str(tmp_path))
    run_context.bind_crawler_facade(facade)
    return ToolContext(
        context=run_context,
        tool_name="capture_web_page",
        tool_call_id="test_call_1",
        tool_arguments="{}",
    )


def _facade_with_png(content: bytes) -> Mock:
    facade = Mock()

    async def screenshot(url: str, **kwargs: object) -> BrowserScreenshotResult:
        workspace = kwargs["workspace"]
        asset = workspace.stage_bytes(
            content=content,
            filename=str(kwargs["filename"]),
            source_id=str(kwargs["source_id"]),
            successful_attempt_id=str(kwargs["successful_attempt_id"]),
            data_level=kwargs["data_level"],
            media_type="image/png",
        )
        return BrowserScreenshotResult(
            url=url,
            path=workspace.staged_path(asset),
            source_asset=asset,
            status_code=200,
            elapsed_ms=2,
        )

    facade.screenshot = AsyncMock(side_effect=screenshot)
    return facade


def test_capture_web_page_commits_png_and_metadata_through_staging(
    tmp_path: Path,
) -> None:
    png = b"\x89PNG\r\n\x1a\nvisual-evidence"
    facade = _facade_with_png(png)
    context = _make_ctx(
        facade=facade,
        task_id="test_visual_capture",
        tmp_path=tmp_path,
    )

    result = asyncio.run(
        capture_web_page.on_invoke_tool(
            context,
            json.dumps(
                {
                    "url": "https://example.org/figure",
                    "label": "figure_1",
                }
            ),
        )
    )

    data = json.loads(result)
    image_path = Path(data["local_files"][0])
    metadata_path = Path(data["meta_file"])
    assert image_path.read_bytes() == png
    assert json.loads(metadata_path.read_text(encoding="utf-8"))["label"] == "figure_1"
    assert image_path.is_relative_to(context.context.work_dir.source_assets)
    assert metadata_path.is_relative_to(context.context.work_dir.source_assets)
    assert context.context.sources[0].accession == "figure_1"
    assert context.context.query_log[0]["status"] == "success"


def test_capture_page_section_forwards_selector_and_clamps_viewport(
    tmp_path: Path,
) -> None:
    facade = _facade_with_png(b"\x89PNG\r\n\x1a\nsection")
    context = _make_ctx(
        facade=facade,
        task_id="test_visual_section",
        tmp_path=tmp_path,
    )

    result = asyncio.run(
        capture_page_section.on_invoke_tool(
            context,
            json.dumps(
                {
                    "url": "https://example.org/paper",
                    "selector": "figure.primary",
                    "viewport_width": 9000,
                    "viewport_height": 9000,
                }
            ),
        )
    )

    assert "error" not in json.loads(result)
    call = facade.screenshot.await_args
    assert call.kwargs["selector"] == "figure.primary"
    assert call.kwargs["full_page"] is False
    assert call.kwargs["viewport_width"] == 1920
    assert call.kwargs["viewport_height"] == 1080


def test_capture_rejects_unsafe_label_before_browser_transport(
    tmp_path: Path,
) -> None:
    facade = _facade_with_png(b"\x89PNG\r\n\x1a\nunused")
    context = _make_ctx(
        facade=facade,
        task_id="test_visual_label",
        tmp_path=tmp_path,
    )

    result = asyncio.run(
        capture_web_page.on_invoke_tool(
            context,
            json.dumps(
                {
                    "url": "https://example.org/figure",
                    "label": "../escape",
                }
            ),
        )
    )

    assert "label must be" in json.loads(result)["error"]
    facade.screenshot.assert_not_awaited()


def test_capture_browser_exception_returns_error_json(tmp_path: Path) -> None:
    facade = Mock()
    facade.screenshot = AsyncMock(side_effect=RuntimeError("browser failed"))
    context = _make_ctx(
        facade=facade,
        task_id="test_visual_error",
        tmp_path=tmp_path,
    )

    result = asyncio.run(
        capture_web_page.on_invoke_tool(
            context,
            json.dumps({"url": "https://example.org/figure"}),
        )
    )

    assert json.loads(result)["error"] == "browser failed"
    assert context.context.query_log[0]["status"] == "failed"
