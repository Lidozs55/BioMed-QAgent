"""Web visual capture skill — Playwright screenshot acquisition for visual
evidence and chart extraction input.

Mirrors ``browser_fallback``'s lightweight provenance pattern: registers a
``SourceRecord`` (loose contract) with ``Database.BROWSER`` and saves PNGs to
``source_assets/figures/``. Does NOT use ``acquire_source()`` because that
function enforces an HTTPS URL whitelist (NCBI/GDC/PDB/PubChem/Reactome/Xena
only) and downloads via httpx — neither fits a Playwright-generated local
screenshot.

Delegates HTTP concerns (browser UA, Referer, stealth, rate limiting) to the
unified crawler layer in ``app.tools.crawler``, ensuring consistent anti-crawler
behavior across all acquisition skills (project_memory L11).

Integration plan: docs/separateweb_capture_integration_plan.md
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext
from app.domain.contracts import Database, QueryStatus, SourceRecord, StageName, make_source_id
from app.skills.registry import SkillCategory, SkillDef, skill_registry
from app.tools.crawler import playwright_screenshot
from app.tools.workdir import TaskWorkDir

logger = logging.getLogger(__name__)

#: Maximum PNG size before a warning is emitted (10 MB).
_MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024

#: Hard limit on viewport dimensions (avoids memory blowup).
_MAX_VIEWPORT_WIDTH = 1920
_MAX_VIEWPORT_HEIGHT = 1080

#: Safe label pattern — only alphanumeric + underscore/hyphen, max 64 chars.
_SAFE_LABEL_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _sha256_file(path: Path) -> str:
    """Compute SHA-256 hex digest of a file."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _build_figure_path(workdir: TaskWorkDir, sha256: str) -> Path:
    """Build the content-addressed destination path for a screenshot.

    The path is ``source_assets/figures/fig_<sha256[:12]>.png`` — content-
    addressed so identical screenshots deduplicate naturally, and the short
    prefix keeps filenames manageable while collision-resistant for a single
    task's expected volume.

    Goes through ``TaskWorkDir.source_asset_file`` so ``_safe_child`` validates
    path safety (no ``..`` escape, no absolute paths).
    """
    return workdir.source_asset_file(f"figures/fig_{sha256[:12]}.png")


def _build_meta_path(workdir: TaskWorkDir, sha256: str) -> Path:
    """Build the per-screenshot metadata JSON path."""
    return workdir.source_asset_file(f"figures/fig_{sha256[:12]}_meta.json")


def _write_meta_json(
    meta_path: Path,
    *,
    url: str,
    sha256: str,
    size_bytes: int,
    viewport_width: int,
    viewport_height: int,
    full_page: bool,
    selector: str | None,
    label: str | None,
    captured_at: datetime,
) -> None:
    """Write the per-screenshot metadata sidecar JSON."""
    meta = {
        "url": url,
        "sha256": sha256,
        "size_bytes": size_bytes,
        "viewport": {"width": viewport_width, "height": viewport_height},
        "full_page": full_page,
        "selector": selector,
        "label": label,
        "captured_at": captured_at.isoformat(),
        "media_type": "image/png",
    }
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2))


def _publish_screenshot(temp_path: Path, dest_path: Path) -> None:
    """Atomically publish a screenshot from temp to source_assets.

    Follows ``browser_fallback._publish_no_clobber`` semantics: hard-link if
    possible, otherwise move. Does not overwrite an existing asset (content-
    addressed naming means the same SHA-256 is the same image).
    """
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os_link = getattr(__import__("os"), "link", None)
        if os_link is not None and not dest_path.exists():
            try:
                os_link(temp_path, dest_path)
                return
            except OSError:
                pass  # Fall through to rename
        if not dest_path.exists():
            temp_path.replace(dest_path)
            return
    finally:
        temp_path.unlink(missing_ok=True)


def _validate_label(label: str | None) -> str | None:
    """Validate that label is safe for use in filenames and logs.

    Returns the sanitized label or None. Rejects path separators, ``..``,
    and other unsafe characters.
    """
    if label is None:
        return None
    if not _SAFE_LABEL_PATTERN.fullmatch(label):
        raise ValueError(
            "label must be 1-64 chars of [A-Za-z0-9_-] only; "
            "path separators and '..' are forbidden"
        )
    return label


async def _do_capture(
    run_ctx: RunContext,
    url: str,
    *,
    full_page: bool,
    viewport_width: int,
    viewport_height: int,
    wait_until: str,
    selector: str | None,
    label: str | None,
) -> str:
    """Shared capture logic for capture_web_page and capture_page_section."""
    try:
        validated_label = _validate_label(label)
    except ValueError as exc:
        run_ctx.log_query(url, "web_visual_capture", QueryStatus.FAILED, 0)
        return json.dumps(
            {
                "source": "web_visual_capture",
                "url": url,
                "error": str(exc),
            },
            ensure_ascii=False,
        )

    temp_path = run_ctx.work_dir.download_temp_file(
        f"capture_{datetime.now(UTC).strftime('%Y%m%d%H%M%S%f')}.png"
    )
    try:
        result = await asyncio.to_thread(
            playwright_screenshot,
            url,
            dest_path=temp_path,
            full_page=full_page,
            viewport_width=viewport_width,
            viewport_height=viewport_height,
            wait_until=wait_until,
            selector=selector,
        )

        if not result.ok:
            run_ctx.log_query(url, "web_visual_capture", QueryStatus.FAILED, 0)
            run_ctx.add_warning(
                severity="warning",
                message=f"capture failed for {url}: {result.error or result.status_code}",
                source="web_visual_capture",
            )
            return json.dumps(
                {
                    "source": "web_visual_capture",
                    "url": url,
                    "status_code": result.status_code,
                    "error": result.error or f"HTTP {result.status_code}",
                    "viewport": {
                        "width": result.viewport_width,
                        "height": result.viewport_height,
                    },
                },
                ensure_ascii=False,
            )

        if not temp_path.exists() or temp_path.stat().st_size == 0:
            run_ctx.log_query(url, "web_visual_capture", QueryStatus.FAILED, 0)
            return json.dumps(
                {
                    "source": "web_visual_capture",
                    "url": url,
                    "error": "screenshot file is missing or empty",
                },
                ensure_ascii=False,
            )

        sha256 = _sha256_file(temp_path)
        size_bytes = temp_path.stat().st_size
        dest_path = _build_figure_path(run_ctx.work_dir, sha256)
        meta_path = _build_meta_path(run_ctx.work_dir, sha256)
        captured_at = datetime.now(UTC)

        # Publish the screenshot (content-addressed; no-clobber if exists)
        _publish_screenshot(temp_path, dest_path)
        temp_path = None  # Consumed by _publish_screenshot

        # Write per-screenshot metadata sidecar
        _write_meta_json(
            meta_path,
            url=url,
            sha256=sha256,
            size_bytes=size_bytes,
            viewport_width=result.viewport_width,
            viewport_height=result.viewport_height,
            full_page=full_page,
            selector=selector,
            label=validated_label,
            captured_at=captured_at,
        )

        # Emit oversize warning if the PNG exceeds the threshold
        if size_bytes > _MAX_SCREENSHOT_BYTES:
            run_ctx.add_warning(
                severity="warning",
                message=(
                    f"screenshot oversize: {size_bytes} bytes "
                    f"(> {_MAX_SCREENSHOT_BYTES}) for {url}"
                ),
                source="web_visual_capture",
            )

        # Register provenance (loose SourceRecord, browser_fallback pattern)
        accession = validated_label or sha256[:12]
        source_record = SourceRecord(
            source_id=make_source_id(Database.BROWSER, accession, url),
            database=Database.BROWSER,
            accession=accession,
            url=url,
            title=f"Web screenshot {accession}",
            retrieved_at=captured_at,
        )
        run_ctx.add_source(source_record)
        run_ctx.add_raw_asset(str(dest_path))
        run_ctx.log_query(url, "web_visual_capture", QueryStatus.SUCCESS, 1)

        # Surface acquisition progress (docs/REVIEW_2026-07-18.md §4)
        await run_ctx.emit_progress(
            stage=StageName.ACQUISITION,
            kind="captured_screenshot",
            current=1,
            total=1,
            detail={
                "source": "web_visual_capture",
                "url": url,
                "label": validated_label,
                "sha256": sha256,
                "size_bytes": size_bytes,
                "viewport": {
                    "width": result.viewport_width,
                    "height": result.viewport_height,
                },
                "full_page": full_page,
                "selector": selector,
            },
        )

        logger.info(
            "web_visual_capture url=%s status=%d bytes=%d dest=%s",
            url, result.status_code, size_bytes, dest_path,
        )

        return json.dumps(
            {
                "source": "web_visual_capture",
                "url": url,
                "status_code": result.status_code,
                "local_files": [str(dest_path)],
                "meta_file": str(meta_path),
                "sha256": sha256,
                "size_bytes": size_bytes,
                "viewport": {
                    "width": result.viewport_width,
                    "height": result.viewport_height,
                },
                "full_page": full_page,
                "selector": selector,
                "label": validated_label,
                "captured_at": captured_at.isoformat(),
                "source_id": source_record.source_id,
            },
            ensure_ascii=False,
        )
    except Exception as exc:
        logger.exception("web_visual_capture failed for url=%r", url)
        run_ctx.log_query(url, "web_visual_capture", QueryStatus.FAILED, 0)
        run_ctx.add_warning(
            severity="warning",
            message=f"capture raised for {url}: {exc}",
            source="web_visual_capture",
        )
        return json.dumps(
            {
                "source": "web_visual_capture",
                "url": url,
                "error": str(exc),
            },
            ensure_ascii=False,
        )
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


@function_tool
async def capture_web_page(
    ctx: RunContextWrapper[Any],
    url: str,
    *,
    full_page: bool = True,
    viewport_width: int = 1920,
    viewport_height: int = 1080,
    wait_until: str = "networkidle",
    label: str | None = None,
) -> str:
    """Capture a full-page screenshot of a biomedical web page.

    Saves a PNG to ``source_assets/figures/fig_<sha256[:12]>.png`` and registers
    it as a provenance SourceRecord (Database.BROWSER). The screenshot can be
    used as visual evidence or as input to a future ``extract_chart_data_vlm``
    tool (TODO §5.2).

    Use this tool when:
    - A biomedical database page contains figures/tables you need visual evidence for.
    - API-based acquisition failed and you need a visual fallback for structural data.
    - You need visual provenance (e.g., screenshot of the accession page).

    Do NOT use this tool for sources that already have structured APIs (PubMed
    E-utilities, GEO ESummary) unless visual provenance is explicitly required.

    The screenshot uses real browser User-Agent, Referer, stealth scripts, and
    2s rate limiting (project_memory L11). Viewport is clamped to 1920x1080 max.

    Args:
        url: Target HTTP(S) URL. Must resolve to a public address.
        full_page: If True (default), capture the full scrollable page.
        viewport_width: Browser viewport width (clamped to 1920 max).
        viewport_height: Browser viewport height (clamped to 1080 max).
        wait_until: Playwright wait strategy. Default "networkidle".
        label: Optional safe label (alphanumeric + _-) for provenance; appears
            in the SourceRecord accession field. Max 64 chars.

    Returns:
        JSON string with local_files, sha256, size_bytes, source_id, etc.
        On failure, returns JSON with an ``error`` field (does not raise).
    """
    run_ctx: RunContext = ctx.context
    return await _do_capture(
        run_ctx,
        url,
        full_page=full_page,
        viewport_width=viewport_width,
        viewport_height=viewport_height,
        wait_until=wait_until,
        selector=None,
        label=label,
    )


@function_tool
async def capture_page_section(
    ctx: RunContextWrapper[Any],
    url: str,
    selector: str,
    *,
    viewport_width: int = 1920,
    viewport_height: int = 1080,
    wait_until: str = "networkidle",
    label: str | None = None,
) -> str:
    """Capture a screenshot of one DOM element on a biomedical web page.

    Like ``capture_web_page`` but only captures the element matching the CSS
    ``selector``. Useful for precisely extracting figure/table regions from
    paper HTML or database accession pages (e.g., ``<figure>``, ``<table>``,
    ``<img>``).

    The first matching element is captured. If the selector matches nothing,
    Playwright raises a timeout error and this tool returns an error JSON.

    Args:
        url: Target HTTP(S) URL. Must resolve to a public address.
        selector: CSS selector identifying the element to capture (e.g.,
            ``"figure"`` or ``"table.data-table"``). Required.
        viewport_width: Browser viewport width (clamped to 1920 max).
        viewport_height: Browser viewport height (clamped to 1080 max).
        wait_until: Playwright wait strategy. Default "networkidle".
        label: Optional safe label (alphanumeric + _-) for provenance.

    Returns:
        JSON string with local_files, sha256, size_bytes, source_id, etc.
        On failure, returns JSON with an ``error`` field (does not raise).
    """
    run_ctx: RunContext = ctx.context
    return await _do_capture(
        run_ctx,
        url,
        full_page=False,
        viewport_width=viewport_width,
        viewport_height=viewport_height,
        wait_until=wait_until,
        selector=selector,
        label=label,
    )


web_visual_capture_skill = SkillDef(
    name="web_visual_capture",
    category=SkillCategory.ACQUISITION,
    description=(
        "Capture web page screenshots for visual evidence and chart extraction. "
        "Uses real browser User-Agent, Referer, stealth scripts, and 2s rate "
        "limiting. Produces content-addressed PNGs under source_assets/figures/. "
        "Use when API endpoints fail or when visual provenance is needed."
    ),
    instructions=(
        "Use web_visual_capture tools when you need visual evidence from a "
        "biomedical web page: (1) capture_web_page for full-page screenshots, "
        "(2) capture_page_section for precise DOM element crops (e.g., a "
        "<figure> or <table> on a paper HTML page). Do NOT use these for "
        "sources with working structured APIs (PubMed, GEO) unless visual "
        "provenance is explicitly required. Screenshots register as "
        "SourceRecord(database=BROWSER) and can feed a future "
        "extract_chart_data_vlm tool."
    ),
    tools=[capture_web_page, capture_page_section],
    supported_sources=["web_visual_capture", "visual_capture", "web"],
    version="0.1.0",
)

skill_registry.register(web_visual_capture_skill)
