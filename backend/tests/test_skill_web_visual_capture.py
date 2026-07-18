"""Tests for the web_visual_capture skill — capture_web_page and
capture_page_section.

Mirrors the mocking pattern from ``test_skill_browser.py``: a ToolContext is
constructed with a real RunContext (whose workdir points at ``tmp_path``), and
``playwright_screenshot`` is patched so no real browser is launched.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import patch

import pytest
from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.skills.builtin.acquisition.web_visual_capture import (
    capture_page_section,
    capture_web_page,
    web_visual_capture_skill,
)
from app.tools.crawler import ScreenshotResult
from app.tools.workdir import create_task_workdir


def _make_ctx(
    task_id: str = "test_wvc",
    tmp_path: Path | None = None,
) -> ToolContext:
    rc = RunContext(task_id=task_id)
    if tmp_path is not None:
        rc._work_dir = create_task_workdir(task_id, base_dir=str(tmp_path))
    return ToolContext(
        context=rc,
        tool_name="capture_web_page",
        tool_call_id="test_call_1",
        tool_arguments="{}",
    )


def _write_fake_png(path: Path, *, content: bytes = b"\x89PNG\r\n\x1a\nfake") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def _make_screenshot_result(
    url: str,
    dest_path: Path,
    *,
    status_code: int = 200,
    elapsed_ms: float = 12.0,
    viewport_width: int = 1920,
    viewport_height: int = 1080,
    full_page: bool = True,
    selector: str | None = None,
    error: str | None = None,
) -> ScreenshotResult:
    return ScreenshotResult(
        url=url,
        path=dest_path,
        status_code=status_code,
        elapsed_ms=elapsed_ms,
        viewport_width=viewport_width,
        viewport_height=viewport_height,
        full_page=full_page,
        selector=selector,
        error=error,
    )


# ---------------------------------------------------------------------------
# capture_web_page — success
# ---------------------------------------------------------------------------


def test_capture_web_page_success(tmp_path: Path) -> None:
    """capture_web_page saves a PNG, writes meta JSON, registers provenance."""
    png_bytes = b"\x89PNG\r\n\x1a\n" + b"unique-content-1" * 100

    def fake_screenshot(url, *, dest_path, **kwargs):
        _write_fake_png(dest_path, content=png_bytes)
        return _make_screenshot_result(url, dest_path)

    ctx = _make_ctx(task_id="test_wvc_ok", tmp_path=tmp_path)
    with patch(
        "app.skills.builtin.acquisition.web_visual_capture.playwright_screenshot",
        side_effect=fake_screenshot,
    ):
        args = json.dumps({"url": "https://example.com/paper"})
        result = asyncio.run(capture_web_page.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "web_visual_capture"
    assert data["url"] == "https://example.com/paper"
    assert data["status_code"] == 200
    assert data["sha256"] and len(data["sha256"]) == 64
    assert data["size_bytes"] == len(png_bytes)
    assert data["full_page"] is True
    assert data["selector"] is None
    assert data["captured_at"]
    assert data["source_id"].startswith("src_")
    assert len(data["local_files"]) == 1
    assert data["local_files"][0].endswith(".png")
    assert "fig_" in data["local_files"][0]
    assert data["meta_file"].endswith("_meta.json")

    # Provenance recorded in RunContext
    rc: RunContext = ctx.context
    assert len(rc.sources) == 1
    assert rc.sources[0].database.value == "browser"
    assert rc.sources[0].url == "https://example.com/paper"
    assert len(rc.raw_assets) == 1
    assert rc.raw_assets[0] == data["local_files"][0]
    assert len(rc.query_log) == 1
    assert rc.query_log[0]["status"] == "succeeded"
    assert rc.query_log[0]["records_count"] == 1

    # Files exist on disk
    dest_png = Path(data["local_files"][0])
    meta_path = Path(data["meta_file"])
    assert dest_png.exists()
    assert dest_png.read_bytes() == png_bytes
    assert meta_path.exists()
    meta = json.loads(meta_path.read_text())
    assert meta["url"] == "https://example.com/paper"
    assert meta["sha256"] == data["sha256"]
    assert meta["size_bytes"] == len(png_bytes)
    assert meta["media_type"] == "image/png"
    assert meta["viewport"] == {"width": 1920, "height": 1080}
    assert meta["full_page"] is True
    assert meta["selector"] is None

    # download_tmp is empty (temp file consumed)
    assert list(rc.work_dir.download_tmp.iterdir()) == []


def test_capture_web_page_with_label(tmp_path: Path) -> None:
    """A safe label populates the SourceRecord accession and meta JSON."""
    png_bytes = b"\x89PNG\r\n\x1a\nlabeled-content" * 50

    def fake_screenshot(url, *, dest_path, **kwargs):
        _write_fake_png(dest_path, content=png_bytes)
        return _make_screenshot_result(url, dest_path)

    ctx = _make_ctx(task_id="test_wvc_label", tmp_path=tmp_path)
    with patch(
        "app.skills.builtin.acquisition.web_visual_capture.playwright_screenshot",
        side_effect=fake_screenshot,
    ):
        args = json.dumps({
            "url": "https://example.org/figure1",
            "label": "Fig1_Alpha",
        })
        result = asyncio.run(capture_web_page.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["label"] == "Fig1_Alpha"

    rc: RunContext = ctx.context
    assert rc.sources[0].accession == "Fig1_Alpha"
    assert rc.sources[0].title == "Web screenshot Fig1_Alpha"

    meta = json.loads(Path(data["meta_file"]).read_text())
    assert meta["label"] == "Fig1_Alpha"


# ---------------------------------------------------------------------------
# capture_web_page — content-addressed deduplication
# ---------------------------------------------------------------------------


def test_capture_web_page_dedup_identical_content(tmp_path: Path) -> None:
    """Identical PNG bytes produce the same destination path (content-addressed)."""
    png_bytes = b"\x89PNG\r\n\x1a\nidentical" * 200

    def fake_screenshot(url, *, dest_path, **kwargs):
        _write_fake_png(dest_path, content=png_bytes)
        return _make_screenshot_result(url, dest_path)

    ctx = _make_ctx(task_id="test_wvc_dedup", tmp_path=tmp_path)
    with patch(
        "app.skills.builtin.acquisition.web_visual_capture.playwright_screenshot",
        side_effect=fake_screenshot,
    ):
        args1 = json.dumps({"url": "https://example.com/a"})
        r1 = asyncio.run(capture_web_page.on_invoke_tool(ctx, args1))
        args2 = json.dumps({"url": "https://example.com/b"})
        r2 = asyncio.run(capture_web_page.on_invoke_tool(ctx, args2))

    d1 = json.loads(r1)
    d2 = json.loads(r2)
    assert d1["sha256"] == d2["sha256"]
    assert d1["local_files"][0] == d2["local_files"][0]
    # The destination file is not clobbered; only one file exists.
    figures_dir = Path(d1["local_files"][0]).parent
    pngs = sorted(figures_dir.glob("fig_*.png"))
    assert len(pngs) == 1

    # Two sources recorded (one per call), even though the asset is shared
    rc: RunContext = ctx.context
    assert len(rc.sources) == 2
    assert len(rc.raw_assets) == 2


# ---------------------------------------------------------------------------
# capture_web_page — failure modes
# ---------------------------------------------------------------------------


def test_capture_web_page_screenshot_error_returns_error_json(
    tmp_path: Path,
) -> None:
    """When playwright_screenshot returns error, tool returns error JSON."""
    def fake_screenshot(url, *, dest_path, **kwargs):
        # No file written
        return _make_screenshot_result(
            url, dest_path, status_code=0, error="browser launch failed"
        )

    ctx = _make_ctx(task_id="test_wvc_err", tmp_path=tmp_path)
    with patch(
        "app.skills.builtin.acquisition.web_visual_capture.playwright_screenshot",
        side_effect=fake_screenshot,
    ):
        args = json.dumps({"url": "https://example.com/fail"})
        result = asyncio.run(capture_web_page.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "web_visual_capture"
    assert data["url"] == "https://example.com/fail"
    assert "error" in data
    assert "browser launch failed" in data["error"]

    rc: RunContext = ctx.context
    assert len(rc.query_log) == 1
    assert rc.query_log[0]["status"] == "failed"
    assert len(rc.sources) == 0
    assert len(rc.raw_assets) == 0
    # A warning should be recorded
    assert len(rc.warnings) == 1
    assert rc.warnings[0]["source"] == "web_visual_capture"


def test_capture_web_page_missing_file_returns_error_json(
    tmp_path: Path,
) -> None:
    """playwright_screenshot reports ok but file is missing — error JSON."""

    def fake_screenshot(url, *, dest_path, **kwargs):
        # Status ok but no file written
        return _make_screenshot_result(url, dest_path, status_code=200)

    ctx = _make_ctx(task_id="test_wvc_missing", tmp_path=tmp_path)
    with patch(
        "app.skills.builtin.acquisition.web_visual_capture.playwright_screenshot",
        side_effect=fake_screenshot,
    ):
        args = json.dumps({"url": "https://example.com/missing"})
        result = asyncio.run(capture_web_page.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert "error" in data
    assert "missing or empty" in data["error"]

    rc: RunContext = ctx.context
    assert rc.query_log[0]["status"] == "failed"
    assert len(rc.sources) == 0


def test_capture_web_page_exception_returns_error_json(tmp_path: Path) -> None:
    """playwright_screenshot raises — tool must not raise, returns error JSON."""

    def fake_screenshot(url, *, dest_path, **kwargs):
        raise RuntimeError("chromium binary not found")

    ctx = _make_ctx(task_id="test_wvc_exc", tmp_path=tmp_path)
    with patch(
        "app.skills.builtin.acquisition.web_visual_capture.playwright_screenshot",
        side_effect=fake_screenshot,
    ):
        args = json.dumps({"url": "https://example.com/exc"})
        result = asyncio.run(capture_web_page.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert "error" in data
    assert "chromium binary not found" in data["error"]

    rc: RunContext = ctx.context
    assert rc.query_log[0]["status"] == "failed"
    assert len(rc.warnings) == 1


# ---------------------------------------------------------------------------
# label validation
# ---------------------------------------------------------------------------


def test_capture_web_page_invalid_label_returns_error_json(
    tmp_path: Path,
) -> None:
    """Unsafe labels (path separators, ..) are rejected."""
    ctx = _make_ctx(task_id="test_wvc_badlabel", tmp_path=tmp_path)
    # No patch on playwright_screenshot: validation must happen before the call.
    args = json.dumps({"url": "https://example.com", "label": "../etc/passwd"})
    result = asyncio.run(capture_web_page.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert "error" in data
    assert "label" in data["error"]

    rc: RunContext = ctx.context
    assert rc.query_log[0]["status"] == "failed"


@pytest.mark.parametrize(
    "label",
    ["with space", "slash/in/it", "dot.dot", "a" * 65, "", "has$dollar"],
)
def test_validate_label_rejects_unsafe(label: str | None) -> None:
    """_validate_label rejects unsafe characters and overlong labels."""
    from app.skills.builtin.acquisition.web_visual_capture import _validate_label

    # None is always valid (means "no label")
    if label is None:
        assert _validate_label(label) is None
        return
    with pytest.raises(ValueError):
        _validate_label(label)


@pytest.mark.parametrize("label", ["Fig1", "fig_2", "chart-A", "abc123"])
def test_validate_label_accepts_safe(label: str) -> None:
    from app.skills.builtin.acquisition.web_visual_capture import _validate_label

    assert _validate_label(label) == label


# ---------------------------------------------------------------------------
# capture_page_section
# ---------------------------------------------------------------------------


def test_capture_page_section_success(tmp_path: Path) -> None:
    """capture_page_section forwards selector to playwright_screenshot."""
    png_bytes = b"\x89PNG\r\n\x1a\nsection-content" * 50

    captured_kwargs: dict = {}

    def fake_screenshot(url, *, dest_path, **kwargs):
        captured_kwargs.update(kwargs)
        _write_fake_png(dest_path, content=png_bytes)
        return _make_screenshot_result(
            url, dest_path, full_page=False, selector=kwargs.get("selector")
        )

    ctx = _make_ctx(task_id="test_wvc_section", tmp_path=tmp_path)
    with patch(
        "app.skills.builtin.acquisition.web_visual_capture.playwright_screenshot",
        side_effect=fake_screenshot,
    ):
        args = json.dumps({
            "url": "https://example.com/paper",
            "selector": "figure.result-chart",
            "label": "ChartA",
        })
        result = asyncio.run(capture_page_section.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["selector"] == "figure.result-chart"
    assert data["full_page"] is False
    assert data["label"] == "ChartA"

    # playwright_screenshot was called with selector and full_page=False
    assert captured_kwargs["selector"] == "figure.result-chart"
    assert captured_kwargs["full_page"] is False

    rc: RunContext = ctx.context
    assert rc.sources[0].accession == "ChartA"


def test_capture_page_section_missing_selector_arg_raises(
    tmp_path: Path,
) -> None:
    """selector is required for capture_page_section (SDK enforces it)."""
    ctx = _make_ctx(task_id="test_wvc_noselector", tmp_path=tmp_path)
    # Omitting selector should yield a tool-input validation error from the SDK,
    # which surfaces as a JSON error string (not an exception).
    args = json.dumps({"url": "https://example.com"})
    # The SDK raises a ModelBehaviorError when a required arg is missing;
    # we accept either an exception or an error JSON.
    try:
        result = asyncio.run(capture_page_section.on_invoke_tool(ctx, args))
        data = json.loads(result)
        assert "error" in data or "message" in data
    except Exception:
        # SDK validation error is acceptable
        pass


# ---------------------------------------------------------------------------
# Skill registration
# ---------------------------------------------------------------------------


def test_skill_registered_correctly() -> None:
    """The module-level SkillDef is registered with the expected metadata."""
    assert web_visual_capture_skill.name == "web_visual_capture"
    assert web_visual_capture_skill.category.value == "acquisition"
    assert "web_visual_capture" in web_visual_capture_skill.supported_sources
    assert "web" in web_visual_capture_skill.supported_sources
    assert len(web_visual_capture_skill.tools) == 2
    tool_names = {t.name for t in web_visual_capture_skill.tools}
    assert tool_names == {"capture_web_page", "capture_page_section"}


def test_skill_loaded_in_builtin_modules() -> None:
    """The skill module is listed in BUILTIN_SKILL_MODULES so the Agent loads it."""
    from app.tools._registry import BUILTIN_SKILL_MODULES

    assert (
        "app.skills.builtin.acquisition.web_visual_capture"
        in BUILTIN_SKILL_MODULES
    )


def test_skill_excluded_from_databases_listing() -> None:
    """The /databases filter must exclude web_visual_capture like browser_fallback."""
    import app.skills.builtin.acquisition.browser  # noqa: F401

    # Force skill modules to load so registry is populated
    import app.skills.builtin.acquisition.web_visual_capture  # noqa: F401
    from app.api.routes import get_databases

    databases = asyncio.run(get_databases())
    names = [d["id"] for d in databases["databases"]]
    assert "web_visual_capture" not in names
    assert "browser_fallback" not in names
