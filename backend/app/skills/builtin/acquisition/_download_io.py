"""Shared download IO for acquisition skills (TODO §2.3/§2.4).

Every acquisition skill that needs to fetch a binary artifact (SDF/MOL, TSV,
SBGN, …) routes the download through the Run-bound crawler facade when the
run is managed (subagent), and falls back to the isolated urllib transport
for main-agent or unit-test runs. This mirrors the per-skill
``_download_file_for_run`` helpers previously duplicated in xena.py and
pdb.py so new download tools don't copy a third/fourth implementation.
"""
from __future__ import annotations

import asyncio
import shutil
import time
import urllib.request
from pathlib import Path
from typing import BinaryIO

from app.agent_loop.context import RunContext

#: 浏览器 User-Agent，避免被反爬识别（AGENTS.md 硬约束）。
_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)

#: 每次外部请求间隔（AGENTS.md 硬约束：2s per request）。
_RATE_LIMIT_SECONDS = 2.0

_last_request_ts: float = 0.0


def _rate_limit() -> None:
    """Sleep so that two consecutive external downloads are at least 2s apart."""
    global _last_request_ts
    now = time.monotonic()
    wait = _RATE_LIMIT_SECONDS - (now - _last_request_ts)
    if wait > 0:
        time.sleep(wait)
    _last_request_ts = time.monotonic()


def _download_bytes(url: str) -> bytes:
    """Download a URL via urllib (isolated legacy transport)."""
    _rate_limit()
    request = urllib.request.Request(
        url,
        headers={"User-Agent": _USER_AGENT},
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=60) as resp:
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


def copyfileobj_to_path(source: BinaryIO, dest: Path) -> None:
    """Copy a file-like object to ``dest`` (atomic via temp file).

    Used by tests that mock ``urllib.request.urlopen`` with a streaming
    response object.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with open(tmp, "wb") as target:
        shutil.copyfileobj(source, target)
    if dest.exists():
        dest.unlink()
    tmp.rename(dest)
