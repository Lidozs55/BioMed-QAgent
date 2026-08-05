"""Shared download IO for acquisition skills (TODO §2.3/§2.4).

Every acquisition skill that needs to fetch a binary artifact (SDF/MOL, TSV,
SBGN, …) routes the download through the Run-bound crawler facade when the
run is managed (subagent), and falls back to the isolated urllib transport
for main-agent or unit-test runs.

This module is the **single convergence host** for:
  - Rate limiting (``rate_limit``) — 2s between requests (AGENTS.md hard constraint)
  - JSON fetching (``fetch_json``) — GET/POST with browser UA + rate limit
  - File downloading (``download_file``) — atomic .part rename + rate limit
  - Run-bound wrappers (``download_bytes_for_run`` / ``download_file_for_run``)

gdc/pdb/xena previously each maintained their own copy of these helpers;
they now import from here (P1.1/P1.2 convergence, REVIEW 2026-08-02).
"""
from __future__ import annotations

import asyncio
import json
import shutil
import time
import urllib.request
from pathlib import Path
from typing import Any

from app.agent_loop.context import RunContext
from app.model_settings import get_runtime_limits
from app.tools.crawler import BROWSER_UA, DEFAULT_RATE_LIMIT_SECONDS

#: 每次外部请求间隔（AGENTS.md 硬约束：2s per request；与 crawler 共用唯一常量）。
_last_request_ts: float = 0.0


def rate_limit() -> None:
    """Sleep so that two consecutive external requests are at least 2s apart.

    Single global timestamp shared across all acquisition skills — stricter
    than per-skill independent windows, matching AGENTS.md's "2s per request"
    global constraint. Kept as a synchronous helper because the urllib
    fallback transport (main-agent runs without a bound crawler facade)
    cannot reuse the async ``crawler.AsyncHostRateLimiter``.
    """
    global _last_request_ts
    now = time.monotonic()
    wait = DEFAULT_RATE_LIMIT_SECONDS - (now - _last_request_ts)
    if wait > 0:
        time.sleep(wait)
    _last_request_ts = time.monotonic()


def fetch_json(
    url: str,
    *,
    method: str = "GET",
    json_body: dict | None = None,
    timeout: float | None = None,
) -> dict[str, Any]:
    """Fetch and parse JSON from a REST API endpoint via urllib.

    Sends a real browser User-Agent, rate-limits calls to 2s apart
    (AGENTS.md hard constraint), and returns the parsed JSON dict.
    ``timeout`` defaults to the persisted runtime limit.
    """
    rate_limit()
    headers: dict[str, str] = {
        "User-Agent": BROWSER_UA,
        "Accept": "application/json",
    }
    data = None
    if method == "POST" and json_body is not None:
        data = json.dumps(json_body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(
        req,
        timeout=(
            timeout
            if timeout is not None
            else get_runtime_limits().http_timeout_seconds
        ),
    ) as resp:
        return json.loads(resp.read().decode())


def download_file(
    url: str,
    dest: Path,
    *,
    timeout: float | None = None,
) -> None:
    """Download a file to *dest*, atomically via a .part temp file."""
    rate_limit()
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(
        url, headers={"User-Agent": BROWSER_UA}, method="GET"
    )
    with urllib.request.urlopen(
        req,
        timeout=(
            timeout
            if timeout is not None
            else get_runtime_limits().http_download_timeout_seconds
        ),
    ) as resp, open(tmp, "wb") as f:
        shutil.copyfileobj(resp, f)
    if dest.exists():
        dest.unlink()
    tmp.rename(dest)


def _download_bytes(url: str) -> bytes:
    """Download a URL via urllib (isolated legacy transport)."""
    rate_limit()
    request = urllib.request.Request(
        url,
        headers={"User-Agent": BROWSER_UA},
        method="GET",
    )
    with urllib.request.urlopen(
        request,
        timeout=get_runtime_limits().http_download_timeout_seconds,
    ) as resp:
        return resp.read()


def _write_download(content: bytes, dest: Path) -> None:
    """Write bytes to a task-local path through an atomic temp file."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    tmp.write_bytes(content)
    tmp.replace(dest)


async def download_bytes_for_run(run_ctx: RunContext, url: str) -> bytes:
    """Download through the bound crawler or isolated legacy transport.

    Returns the raw bytes; the caller decides whether to stage a SourceAsset
    (managed subagent) or write a raw task file (main agent).
    """
    facade = run_ctx.crawler_facade_or_none
    if facade is None:
        if run_ctx.subagent_id is not None:
            raise RuntimeError("crawler facade is not bound to the child Run")
        return await asyncio.to_thread(_download_bytes, url)
    result = await facade.download(url)
    if not result.ok:
        raise RuntimeError(result.error or f"HTTP {result.status_code}")
    return result.content


async def download_file_for_run(run_ctx: RunContext, url: str, dest: Path) -> None:
    """Download a URL to ``dest`` through facade or urllib."""
    content = await download_bytes_for_run(run_ctx, url)
    await asyncio.to_thread(_write_download, content, dest)
