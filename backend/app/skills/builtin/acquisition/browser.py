"""Browser fallback acquisition skill — HTTP-based page navigation and file download
for biomedical databases when API endpoints are unavailable."""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

import httpx
from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext
from app.domain.output import SourceRecord
from app.skills.registry import SkillCategory, SkillDef, skill_registry

logger = logging.getLogger(__name__)

_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
_MAX_BODY_CHARS = 5000


def _extract_title(html: str) -> str:
    """Extract <title> tag content via regex."""
    m = re.search(r"<title[^>]*>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
    return m.group(1).strip() if m else ""


def _extract_body_text(html: str) -> str:
    """Extract visible text from HTML body by stripping tags and collapsing whitespace."""
    # Remove script, style, and head blocks
    cleaned = re.sub(
        r"<(script|style|head|noscript)[^>]*>.*?</\1>",
        "", html, flags=re.IGNORECASE | re.DOTALL,
    )
    # Strip remaining HTML tags
    text = re.sub(r"<[^>]+>", " ", cleaned)
    # Decode common entities
    text = text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    text = text.replace("&quot;", '"').replace("&#39;", "'").replace("&nbsp;", " ")
    # Collapse whitespace
    text = re.sub(r"\s+", " ", text).strip()
    return text


@function_tool
async def navigate_page(ctx: RunContextWrapper[Any], url: str) -> str:
    """Navigate to a web page via HTTP and return page metadata and visible text.

    Fetches the page with a browser User-Agent, extracts the <title> and
    visible body text (up to 5000 characters). Use this as a last-resort
    tool when API endpoints are unavailable.
    """
    run_ctx: RunContext = ctx.context

    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        resp = await client.get(url, headers={"User-Agent": _BROWSER_UA})
        status_code = resp.status_code
        content_type = resp.headers.get("content-type", "")

    logger.info(
        "navigate_page url=%s status=%d content_type=%s bytes=%d",
        url, status_code, content_type, len(resp.content),
    )

    html = resp.text
    title = _extract_title(html)
    body_text = _extract_body_text(html)

    return json.dumps({
        "url": url,
        "status_code": status_code,
        "title": title,
        "body_text_preview": body_text[:_MAX_BODY_CHARS],
        "content_type": content_type,
    })


@function_tool
async def download_from_page(
    ctx: RunContextWrapper[Any], url: str, filename: str,
) -> str:
    """Download a file from a URL via HTTP streaming to the task raw directory.

    Detects Content-Type, streams the response to task/raw/<filename>,
    and creates a SourceRecord for provenance tracking. Use this as a
    last-resort download tool when API endpoints fail.
    """
    run_ctx: RunContext = ctx.context

    async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
        async with client.stream(
            "GET", url, headers={"User-Agent": _BROWSER_UA},
        ) as resp:
            status_code = resp.status_code
            content_type = resp.headers.get("content-type", "")
            mime_type = content_type.split(";")[0].strip() if content_type else None

            dest = run_ctx.work_dir.raw / filename
            dest.parent.mkdir(parents=True, exist_ok=True)
            bytes_received = 0
            with open(dest, "wb") as f:
                async for chunk in resp.aiter_bytes():
                    f.write(chunk)
                    bytes_received += len(chunk)

    logger.info(
        "download_from_page url=%s status=%d content_type=%s bytes=%d dest=%s",
        url, status_code, content_type, bytes_received, dest,
    )

    if status_code >= 400:
        return json.dumps({
            "source": "browser_fallback",
            "accession": filename,
            "source_url": url,
            "local_files": [],
            "error": f"HTTP {status_code}",
        })

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

    return json.dumps({
        "source": "browser_fallback",
        "source_url": url,
        "local_files": [local_path],
        "mime_type": mime_type,
        "bytes_received": bytes_received,
        "retrieved_at": source_record.retrieved_at.isoformat(),
    })


browser_fallback_skill = SkillDef(
    name="browser_fallback",
    category=SkillCategory.ACQUISITION,
    description=(
        "Last-resort HTTP browser fallback for navigating pages and downloading "
        "files from biomedical databases when API tools fail. Uses direct HTTP "
        "requests with browser User-Agent instead of requiring a browser process."
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
    version="0.1.0",
)

skill_registry.register(browser_fallback_skill)
