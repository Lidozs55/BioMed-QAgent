"""Live tests for the web_visual_capture skill — exercises real Playwright
Chromium against public web pages.

Marked with ``pytest.mark.live`` so they are skipped by default
(``uv run pytest``) and only run with ``uv run pytest -m live``.

These tests require Playwright Chromium to be installed:
    uv run playwright install chromium
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.skills.builtin.acquisition.web_visual_capture import (
    capture_page_section,
    capture_web_page,
)
from app.tools.workdir import create_task_workdir

pytestmark = pytest.mark.live


def _make_ctx(tmp_path: Path, task_id: str) -> ToolContext:
    rc = RunContext(task_id=task_id)
    rc._work_dir = create_task_workdir(task_id, base_dir=str(tmp_path))
    return ToolContext(
        context=rc,
        tool_name="capture_web_page",
        tool_call_id="live_call",
        tool_arguments="{}",
    )


def test_capture_web_page_live_example_com(tmp_path: Path) -> None:
    """Capture a live screenshot of example.com (most stable public page)."""
    ctx = _make_ctx(tmp_path, "live_wvc_example")

    args = json.dumps({
        "url": "https://example.com",
        "label": "ExampleHome",
        "viewport_width": 1280,
        "viewport_height": 720,
    })
    result = asyncio.run(capture_web_page.on_invoke_tool(ctx, args))
    data = json.loads(result)

    if "error" in data:
        pytest.skip(
            f"live capture failed (network or Playwright unavailable): "
            f"{data['error']}"
        )

    assert data["source"] == "web_visual_capture"
    assert data["url"] == "https://example.com"
    assert data["status_code"] == 200
    assert data["label"] == "ExampleHome"
    assert data["viewport"]["width"] == 1280
    assert data["viewport"]["height"] == 720
    assert data["full_page"] is True
    assert data["sha256"] and len(data["sha256"]) == 64
    assert data["size_bytes"] > 0

    # File exists on disk and is a PNG
    png_path = Path(data["local_files"][0])
    assert png_path.exists()
    assert png_path.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"

    # Metadata sidecar is correct
    meta_path = Path(data["meta_file"])
    assert meta_path.exists()
    meta = json.loads(meta_path.read_text())
    assert meta["url"] == "https://example.com"
    assert meta["label"] == "ExampleHome"
    assert meta["media_type"] == "image/png"

    # Provenance recorded
    rc: RunContext = ctx.context
    assert len(rc.sources) == 1
    assert rc.sources[0].database.value == "browser"
    assert rc.sources[0].accession == "ExampleHome"
    assert rc.sources[0].url == "https://example.com"
    assert len(rc.query_log) == 1
    assert rc.query_log[0]["status"] == "succeeded"


def test_capture_page_section_live_example_h1(tmp_path: Path) -> None:
    """Capture the <h1> element of example.com (a real DOM element)."""
    ctx = _make_ctx(tmp_path, "live_wvc_section")

    args = json.dumps({
        "url": "https://example.com",
        "selector": "h1",
        "label": "ExampleH1",
    })
    result = asyncio.run(capture_page_section.on_invoke_tool(ctx, args))
    data = json.loads(result)

    if "error" in data:
        pytest.skip(
            f"live capture failed (network or Playwright unavailable): "
            f"{data['error']}"
        )

    assert data["selector"] == "h1"
    assert data["full_page"] is False
    assert data["label"] == "ExampleH1"
    assert data["size_bytes"] > 0

    png_path = Path(data["local_files"][0])
    assert png_path.exists()
    assert png_path.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"


def test_capture_web_page_live_dedup_same_url(tmp_path: Path) -> None:
    """Capturing the same URL twice in one task dedups the PNG (content-addressed)."""
    ctx = _make_ctx(tmp_path, "live_wvc_dedup")

    args = json.dumps({"url": "https://example.com", "full_page": True})
    r1 = asyncio.run(capture_web_page.on_invoke_tool(ctx, args))
    r2 = asyncio.run(capture_web_page.on_invoke_tool(ctx, args))

    d1 = json.loads(r1)
    d2 = json.loads(r2)

    if "error" in d1 or "error" in d2:
        pytest.skip("live capture failed (network or Playwright unavailable)")

    assert d1["sha256"] == d2["sha256"]
    assert d1["local_files"][0] == d2["local_files"][0]

    # Only one PNG file exists in figures/
    figures_dir = Path(d1["local_files"][0]).parent
    pngs = sorted(figures_dir.glob("fig_*.png"))
    assert len(pngs) == 1

    # But two SourceRecords (one per call)
    rc: RunContext = ctx.context
    assert len(rc.sources) == 2


# ---------------------------------------------------------------------------
# Real paper page + Wikipedia table extraction
# ---------------------------------------------------------------------------

#: Stable open-access article on Europe PMC (project_memory: use EPMC as
#: alternative paper channel). Renders without <table> but has iframes.
_EPMC_ARTICLE_URL = "https://europepmc.org/article/MED/32815912"

#: BMC open-access article with 14 <figure> elements (verified via
#: playwright_fetch). Used for figure extraction demo.
_BMC_ARTICLE_URL = (
    "https://bmcbioinformatics.biomedcentral.com/articles/10.1186/s12859-020-03731-y"
)

#: Wikipedia page with many stable <table> elements — the canonical
#: "extract a table from a web page" reference target.
_WIKIPEDIA_TABLE_URL = "https://en.wikipedia.org/wiki/BRCA1"


def test_capture_paper_full_page_live(tmp_path: Path) -> None:
    """Capture the full page of a real Europe PMC open-access article."""
    ctx = _make_ctx(tmp_path, "live_wvc_paper_full")

    args = json.dumps({
        "url": _EPMC_ARTICLE_URL,
        "label": "EPMC_Paper_Full",
        "viewport_width": 1280,
        "viewport_height": 900,
    })
    result = asyncio.run(capture_web_page.on_invoke_tool(ctx, args))
    data = json.loads(result)

    if "error" in data:
        pytest.skip(
            f"live capture failed (network or Playwright unavailable): "
            f"{data['error']}"
        )

    assert data["source"] == "web_visual_capture"
    assert data["url"] == _EPMC_ARTICLE_URL
    assert data["status_code"] == 200
    assert data["size_bytes"] > 1000  # Full page should be > 1KB

    png_path = Path(data["local_files"][0])
    assert png_path.exists()
    assert png_path.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"
    print(f"\n[Full paper screenshot] {png_path} ({data['size_bytes']} bytes)")


def test_capture_paper_figure_section_live(tmp_path: Path) -> None:
    """Capture the first <figure> element from a BMC open-access article.

    BMC articles use native <figure> elements for charts and illustrations.
    This is the canonical 'extract a figure from a paper page' use case.
    Uses ``wait_until="load"`` instead of ``networkidle`` because BMC pages
    have continuous analytics/ad traffic that never reaches network idle.
    """
    ctx = _make_ctx(tmp_path, "live_wvc_paper_figure")

    args = json.dumps({
        "url": _BMC_ARTICLE_URL,
        "selector": "figure",
        "label": "BMC_Paper_Figure1",
        "viewport_width": 1280,
        "viewport_height": 900,
        "wait_until": "load",
    })
    result = asyncio.run(capture_page_section.on_invoke_tool(ctx, args))
    data = json.loads(result)

    if "error" in data:
        pytest.skip(
            f"live capture failed (network, Playwright, or no <figure> on page): "
            f"{data['error']}"
        )

    assert data["selector"] == "figure"
    assert data["full_page"] is False
    assert data["label"] == "BMC_Paper_Figure1"
    assert data["size_bytes"] > 0

    png_path = Path(data["local_files"][0])
    assert png_path.exists()
    assert png_path.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"

    rc: RunContext = ctx.context
    assert rc.sources[0].accession == "BMC_Paper_Figure1"
    assert rc.sources[0].url == _BMC_ARTICLE_URL

    print(f"\n[Paper figure screenshot] {png_path} ({data['size_bytes']} bytes)")


def test_capture_wikipedia_table_section_live(tmp_path: Path) -> None:
    """Capture the first <table> element from a Wikipedia article.

    Wikipedia is the most stable public reference for native HTML <table>
    elements. This validates the 'extract a table from a web page' use case
    end-to-end (selector → PNG → provenance).
    """
    ctx = _make_ctx(tmp_path, "live_wvc_wiki_table")

    args = json.dumps({
        "url": _WIKIPEDIA_TABLE_URL,
        "selector": "table.infobox",
        "label": "Wiki_BRCA1_Infobox",
        "viewport_width": 1280,
        "viewport_height": 900,
    })
    result = asyncio.run(capture_page_section.on_invoke_tool(ctx, args))
    data = json.loads(result)

    if "error" in data:
        pytest.skip(
            f"live capture failed (network, Playwright, or no table.infobox): "
            f"{data['error']}"
        )

    assert data["selector"] == "table.infobox"
    assert data["full_page"] is False
    assert data["label"] == "Wiki_BRCA1_Infobox"
    assert data["size_bytes"] > 0

    png_path = Path(data["local_files"][0])
    assert png_path.exists()
    assert png_path.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"

    rc: RunContext = ctx.context
    assert rc.sources[0].accession == "Wiki_BRCA1_Infobox"
    assert rc.sources[0].url == _WIKIPEDIA_TABLE_URL

    print(f"\n[Wikipedia table screenshot] {png_path} ({data['size_bytes']} bytes)")
