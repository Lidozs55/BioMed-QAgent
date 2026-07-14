"""Browser fallback acquisition skill — HTTP-based page navigation and file download
for biomedical databases when API endpoints are unavailable.

This skill delegates HTTP concerns (browser UA, Referer, rate limiting) to the
unified crawler layer in ``app.tools.crawler``, ensuring consistent anti-crawler
behavior across all acquisition skills (project_memory L11).
"""
from __future__ import annotations

import json
import logging
from typing import Any

import httpx
from agents import RunContextWrapper, function_tool
from bs4 import BeautifulSoup

from app.agent_loop.context import RunContext
from app.domain.output import SourceRecord
from app.skills.registry import SkillCategory, SkillDef, skill_registry
from app.tools.crawler import BROWSER_HEADERS, _rate_limiter
from app.tools.network_safety import async_validate_public_http_request

logger = logging.getLogger(__name__)

_MAX_BODY_CHARS = 5000


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
    """Navigate to a web page via HTTP and return page metadata and visible text.

    Fetches the page with real browser User-Agent, Referer, and Accept headers
    (project_memory L11), rate-limited to 2s between requests. Extracts the
    <title> and visible body text (up to 5000 characters) using BeautifulSoup.
    Use this as a last-resort tool when API endpoints are unavailable.
    """
    run_ctx: RunContext = ctx.context
    _rate_limiter.wait()
    try:
        async with httpx.AsyncClient(
            timeout=30.0,
            follow_redirects=True,
            event_hooks={"request": [async_validate_public_http_request]},
        ) as client:
            resp = await client.get(url, headers=BROWSER_HEADERS)
            status_code = resp.status_code
            content_type = resp.headers.get("content-type", "")

        logger.info(
            "navigate_page url=%s status=%d content_type=%s bytes=%d",
            url, status_code, content_type, len(resp.content),
        )

        html = resp.text
        title = _extract_title(html)
        body_text = _extract_body_text(html)

        run_ctx.log_query(url, "browser_fallback", "succeeded", 1)
        return json.dumps({
            "url": url,
            "status_code": status_code,
            "title": title,
            "body_text_preview": body_text[:_MAX_BODY_CHARS],
            "content_type": content_type,
        }, ensure_ascii=False)
    except Exception as exc:
        run_ctx.log_query(url, "browser_fallback", "failed", 0)
        return json.dumps({
            "url": url,
            "error": str(exc),
        }, ensure_ascii=False)


@function_tool
async def download_from_page(
    ctx: RunContextWrapper[Any], url: str, filename: str,
) -> str:
    """Download a file through task-local temporary storage into source assets.

    Uses real browser User-Agent, Referer, and Accept headers with 2s rate
    limiting (project_memory L11). Detects Content-Type, streams the response
    to download_tmp before atomically moving it to source_assets, and creates a
    SourceRecord for provenance tracking.
    Use this as a last-resort download tool when API endpoints fail.
    """
    run_ctx: RunContext = ctx.context
    _rate_limiter.wait()
    temp_path = None
    try:
        temp_target = run_ctx.work_dir.download_temp_file(f"{filename}.part")
        dest = run_ctx.work_dir.source_asset_file(filename)
        if dest.exists():
            raise FileExistsError(f"source asset already exists: {filename}")

        async with (
            httpx.AsyncClient(
                timeout=120.0,
                follow_redirects=True,
                event_hooks={"request": [async_validate_public_http_request]},
            ) as client,
            client.stream(
                "GET", url, headers=BROWSER_HEADERS,
            ) as resp,
        ):
            status_code = resp.status_code
            content_type = resp.headers.get("content-type", "")
            mime_type = content_type.split(";")[0].strip() if content_type else None

            if status_code >= 400:
                run_ctx.log_query(filename, "browser_fallback", "failed", 0)
                return json.dumps({
                    "source": "browser_fallback",
                    "accession": filename,
                    "source_url": url,
                    "local_files": [],
                    "error": f"HTTP {status_code}",
                }, ensure_ascii=False)

            bytes_received = 0
            temp_path = temp_target
            with temp_path.open("wb") as f:
                async for chunk in resp.aiter_bytes():
                    f.write(chunk)
                    bytes_received += len(chunk)

        if dest.exists():
            raise FileExistsError(f"source asset already exists: {filename}")
        temp_path.replace(dest)

        logger.info(
            "download_from_page url=%s status=%d content_type=%s bytes=%d dest=%s",
            url, status_code, content_type, bytes_received, dest,
        )

        local_path = str(dest)
        run_ctx.add_raw_asset(local_path)

        source_record = SourceRecord(
            source="browser_fallback",
            accession=filename,
            source_url=url,
            local_files=[local_path],
            mime_type=mime_type,
            format_hint="browser_download",
        )
        run_ctx.add_source(source_record)
        run_ctx.log_query(filename, "browser_fallback", "succeeded", 1)

        return json.dumps({
            "source": "browser_fallback",
            "source_url": url,
            "local_files": [local_path],
            "mime_type": mime_type,
            "bytes_received": bytes_received,
            "retrieved_at": source_record.retrieved_at.isoformat(),
        }, ensure_ascii=False)
    except Exception as exc:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)
        run_ctx.log_query(filename, "browser_fallback", "failed", 0)
        return json.dumps({
            "source": "browser_fallback",
            "accession": filename,
            "source_url": url,
            "error": str(exc),
        }, ensure_ascii=False)


browser_fallback_skill = SkillDef(
    name="browser_fallback",
    category=SkillCategory.ACQUISITION,
    description=(
        "Last-resort HTTP browser fallback for navigating pages and downloading "
        "files from biomedical databases when API tools fail. Uses real browser "
        "User-Agent, Referer, Accept headers, and 2s rate limiting. HTML parsing "
        "uses BeautifulSoup."
    ),
    instructions=(
        "Use browser_fallback tools only when API endpoints (PubMed, GEO, PDB, "
        "etc.) are unavailable or return errors. navigate_page fetches a page and "
        "extracts title and body text. download_from_page downloads files directly "
        "via HTTP streaming to the task raw directory. "
        "All downloads are tracked in provenance."
    ),
    tools=[navigate_page, download_from_page],
    supported_sources=["browser_fallback", "http", "web"],
    version="0.2.0",
)

skill_registry.register(browser_fallback_skill)
