"""Browser fallback acquisition skill — rendered page navigation and file download
for biomedical databases when API endpoints are unavailable.

This skill delegates HTTP concerns (browser UA, Referer, rate limiting) to the
unified crawler layer in ``app.tools.crawler``, ensuring consistent anti-crawler
behavior across all acquisition skills (project_memory L11).
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from agents import RunContextWrapper, function_tool
from bs4 import BeautifulSoup

from app.agent_loop.context import RunContext
from app.domain.contracts import (
    Database,
    DataLevel,
    DownloadAttempt,
    DownloadStatus,
    QueryStatus,
    SourceRecord,
    generate_prefixed_uuid,
    make_source_id,
)
from app.skills.registry import SkillCategory, SkillDef, skill_registry

logger = logging.getLogger(__name__)

_MAX_BODY_CHARS = 5000


def _validate_download_filename(filename: str) -> None:
    if (
        not filename
        or Path(filename).name != filename
        or filename in {".", ".."}
        or "\\" in filename
    ):
        raise ValueError("source asset filename is unsafe")


def _extract_title(html: str) -> str:
    """Extract <title> tag content via BeautifulSoup."""
    soup = BeautifulSoup(html, "html.parser")
    if soup.title and soup.title.string:
        return soup.title.string.strip()
    return ""


def _extract_body_text(html: str) -> str:
    """Extract visible text from HTML body via BeautifulSoup.

    Removes script/style/head/noscript blocks, then extracts visible text
    with whitespace collapsed.
    """
    soup = BeautifulSoup(html, "html.parser")
    # Remove non-content tags
    for tag in soup(["script", "style", "head", "noscript"]):
        tag.decompose()
    text = soup.get_text(separator=" ", strip=True)
    # Collapse whitespace
    return " ".join(text.split())


@function_tool
async def navigate_page(ctx: RunContextWrapper[Any], url: str) -> str:
    """Navigate with Playwright and return page metadata and visible text.

    Fetches the page through the guarded Playwright crawler with real browser
    headers, rate-limited to 2s between requests. Extracts the
    <title> and visible body text (up to 5000 characters) using BeautifulSoup.
    Use this as a last-resort tool when API endpoints are unavailable.
    """
    run_ctx: RunContext = ctx.context
    try:
        result = await run_ctx.crawler_facade.browser(url)
        if not result.ok:
            run_ctx.log_query(url, "browser_fallback", QueryStatus.FAILED, 0)
            return json.dumps(
                {
                    "url": url,
                    "status_code": result.status_code,
                    "method_used": result.method_used,
                    "error": result.error or f"HTTP {result.status_code}",
                },
                ensure_ascii=False,
            )

        status_code = result.status_code
        content_type = result.headers.get("content-type", "")

        logger.info(
            "navigate_page url=%s status=%d content_type=%s bytes=%d",
            url,
            status_code,
            content_type,
            len(result.content),
        )

        html = result.content
        title = _extract_title(html)
        body_text = _extract_body_text(html)

        run_ctx.log_query(url, "browser_fallback", QueryStatus.SUCCESS, 1)
        return json.dumps(
            {
                "url": url,
                "status_code": status_code,
                "method_used": result.method_used,
                "title": title,
                "body_text_preview": body_text[:_MAX_BODY_CHARS],
                "content_type": content_type,
            },
            ensure_ascii=False,
        )
    except Exception as exc:
        run_ctx.log_query(url, "browser_fallback", QueryStatus.FAILED, 0)
        return json.dumps(
            {
                "url": url,
                "error": str(exc),
            },
            ensure_ascii=False,
        )


@function_tool
async def download_from_page(
    ctx: RunContextWrapper[Any],
    url: str,
    filename: str,
) -> str:
    """Download a file through isolated staging into immutable source assets.

    Uses the bounded Run-owned crawler facade, records a DownloadAttempt, then
    stages, validates, and atomically commits a checksum-addressed SourceAsset.
    Use this as a last-resort download tool when API endpoints fail.
    """
    run_ctx: RunContext = ctx.context
    try:
        _validate_download_filename(filename)
        legacy_destination = run_ctx.work_dir.source_asset_file(filename)
        if legacy_destination.exists():
            raise FileExistsError(f"source asset already exists: {filename}")
        started_at = datetime.now(UTC)
        source_id = make_source_id(Database.BROWSER, filename, url)
        attempt_id = generate_prefixed_uuid("download_attempt")
        workspace = run_ctx.source_asset_workspace()
        result = await run_ctx.crawler_facade.download(url)
        finished_at = datetime.now(UTC)
        status_code = result.status_code
        content_type = result.headers.get("content-type", "")
        mime_type = (
            content_type.split(";")[0].strip()
            if content_type
            else "application/octet-stream"
        )
        if not result.ok:
            run_ctx.log_query(filename, "browser_fallback", QueryStatus.FAILED, 0)
            return json.dumps(
                {
                    "source": "browser_fallback",
                    "accession": filename,
                    "source_url": url,
                    "local_files": [],
                    "error": result.error or f"HTTP {status_code}",
                },
                ensure_ascii=False,
            )
        bytes_received = len(result.content)
        download_attempt = DownloadAttempt(
            attempt_id=attempt_id,
            source_id=source_id,
            url=url,
            status=DownloadStatus.SUCCEEDED,
            bytes_received=bytes_received,
            started_at=started_at,
            finished_at=finished_at,
        )
        source_asset = await asyncio.to_thread(
            workspace.stage_bytes,
            content=result.content,
            filename=filename,
            source_id=source_id,
            successful_attempt_id=attempt_id,
            data_level=DataLevel.METADATA,
            media_type=mime_type,
        )
        await asyncio.to_thread(
            workspace.validate_source_asset,
            source_asset,
        )
        committed = await asyncio.to_thread(
            workspace.commit_source_asset,
            source_asset,
        )
        run_ctx.record_source_asset_id(committed.asset_id)
        destination = workspace.task_root / committed.relative_path

        logger.info(
            "download_from_page url=%s status=%d content_type=%s bytes=%d dest=%s",
            url,
            status_code,
            content_type,
            bytes_received,
            destination,
        )

        local_path = str(destination)
        run_ctx.add_raw_asset(local_path)

        source_record = SourceRecord(
            source_id=source_id,
            database=Database.BROWSER,
            accession=filename,
            url=url,
            title=f"Browser download {filename}",
            retrieved_at=finished_at,
        )
        run_ctx.add_source(source_record)
        run_ctx.log_query(filename, "browser_fallback", QueryStatus.SUCCESS, 1)

        return json.dumps(
            {
                "source": "browser_fallback",
                "source_url": url,
                "local_files": [local_path],
                "mime_type": mime_type,
                "bytes_received": bytes_received,
                "retrieved_at": finished_at.isoformat(),
                "source_asset": committed.model_dump(mode="json"),
                "download_attempt": download_attempt.model_dump(mode="json"),
            },
            ensure_ascii=False,
        )
    except Exception as exc:
        run_ctx.log_query(filename, "browser_fallback", QueryStatus.FAILED, 0)
        return json.dumps(
            {
                "source": "browser_fallback",
                "accession": filename,
                "source_url": url,
                "error": str(exc),
            },
            ensure_ascii=False,
        )


browser_fallback_skill = SkillDef(
    name="browser_fallback",
    category=SkillCategory.ACQUISITION,
    description=(
        "Last-resort rendered browser fallback for navigating pages and downloading "
        "files from biomedical databases when API tools fail. Uses real browser "
        "User-Agent, Referer, Accept headers, and 2s rate limiting. HTML parsing "
        "uses BeautifulSoup."
    ),
    instructions=(
        "Use browser_fallback tools only when API endpoints (PubMed, GEO, PDB, "
        "etc.) are unavailable or return errors. navigate_page renders a page and "
        "extracts title and body text. download_from_page downloads files directly "
        "through isolated staging, validates a checksum-addressed SourceAsset, "
        "and records linked download provenance."
    ),
    tools=[navigate_page, download_from_page],
    supported_sources=["browser_fallback", "http", "web"],
    version="0.2.0",
)

skill_registry.register(browser_fallback_skill)
