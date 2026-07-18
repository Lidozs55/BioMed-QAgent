"""Unified crawler layer — three-tier fallback chain: api > httpx > crawl.

This module provides the shared HTTP fetching primitives used by acquisition
skills. The design follows the project_memory hard constraints:

- All crawlers use real browser User-Agent, Referer headers, and 2s rate limiting
- JS-heavy sites use Playwright Chromium with stealth scripts and networkidle
- Non-JS sites use httpx + BeautifulSoup with retry mechanism

Three-tier fallback chain:
    1. API first (httpx calling REST endpoint, structured JSON)
    2. httpx second (httpx + browser UA, direct page fetch)
    3. crawl fallback (Playwright real browser, stealth + networkidle)
"""
from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import httpx

from app.tools.network_safety import (
    validate_public_http_request,
    validate_public_http_url,
)

logger = logging.getLogger(__name__)

# Real Chrome User-Agent (project_memory L11: real browser UA required)
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)

# Default headers for all requests (project_memory L11: Referer + Accept required)
BROWSER_HEADERS: dict[str, str] = {
    "User-Agent": BROWSER_UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
    "Referer": "https://www.google.com/",
}

# Stealth JS to hide webdriver flag (project_memory L12: stealth scripts required)
STEALTH_JS = """
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
window.chrome = {runtime: {}};
"""

# Rate limiting: 2s between requests (project_memory L11)
_RATE_LIMIT_SECONDS = 2.0


@dataclass
class FetchResult:
    """Result of a fetch operation."""

    url: str
    content: str
    status_code: int
    elapsed_ms: float
    method_used: str  # "api" | "httpx" | "crawl"
    error: str | None = None
    headers: dict[str, str] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return 200 <= self.status_code < 300 and self.error is None


class CrawlError(Exception):
    """Raised when all fetch methods fail."""


class RateLimiter:
    """Simple rate limiter ensuring >= 2s between requests (project_memory L11)."""

    def __init__(self, min_interval: float = _RATE_LIMIT_SECONDS) -> None:
        self._min_interval = min_interval
        self._last_request_time: float = 0.0
        self._lock = threading.Lock()

    def wait(self) -> None:
        """Block until the minimum interval has elapsed since the last request."""
        with self._lock:
            now = time.monotonic()
            elapsed = now - self._last_request_time
            if elapsed < self._min_interval:
                sleep_time = self._min_interval - elapsed
                logger.debug("RateLimiter sleeping %.2fs", sleep_time)
                time.sleep(sleep_time)
            self._last_request_time = time.monotonic()


# Module-level rate limiter instance for shared use
_rate_limiter = RateLimiter()


def _guard_playwright_route(route: Any) -> None:
    validate_public_http_url(route.request.url)
    route.continue_()


def httpx_fetch(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    timeout: float = 30.0,
    follow_redirects: bool = True,
) -> FetchResult:
    """Fetch a URL using httpx with browser UA + Referer + Accept headers.

    This is the second tier in the fallback chain (after API attempts fail).
    Suitable for non-JS pages that return static HTML.

    Args:
        url: Target URL.
        headers: Optional extra headers merged on top of BROWSER_HEADERS.
        timeout: Request timeout in seconds.
        follow_redirects: Whether to follow HTTP redirects.

    Returns:
        FetchResult with the page content.
    """
    _rate_limiter.wait()

    merged_headers = {**BROWSER_HEADERS, **(headers or {})}
    start = time.monotonic()

    try:
        with httpx.Client(
            timeout=timeout,
            follow_redirects=follow_redirects,
            event_hooks={"request": [validate_public_http_request]},
        ) as client:
            response = client.get(url, headers=merged_headers)
            elapsed_ms = (time.monotonic() - start) * 1000
            return FetchResult(
                url=url,
                content=response.text,
                status_code=response.status_code,
                elapsed_ms=elapsed_ms,
                method_used="httpx",
                headers=dict(response.headers),
            )
    except Exception as exc:
        elapsed_ms = (time.monotonic() - start) * 1000
        logger.warning("httpx_fetch failed for %s: %s", url, exc)
        return FetchResult(
            url=url,
            content="",
            status_code=0,
            elapsed_ms=elapsed_ms,
            method_used="httpx",
            error=str(exc),
        )


def playwright_fetch(
    url: str,
    *,
    wait_until: str = "networkidle",
    timeout: float = 60.0,
    extra_headers: dict[str, str] | None = None,
) -> FetchResult:
    """Fetch a URL using Playwright Chromium with stealth scripts.

    This is the third tier (crawl fallback) for JS-heavy sites that cannot be
    fetched with httpx alone. Injects stealth scripts to hide the webdriver
    flag and waits for networkidle to ensure JS rendering completes.

    Args:
        url: Target URL.
        wait_until: Playwright wait strategy ("networkidle", "domcontentloaded",
            "load", "commit").
        timeout: Navigation timeout in seconds.
        extra_headers: Optional extra headers.

    Returns:
        FetchResult with the fully rendered page content.

    Raises:
        CrawlError: If Playwright is not installed or browser launch fails.
    """
    _rate_limiter.wait()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise CrawlError(
            "Playwright is not installed. Run: uv add playwright && "
            "uv run playwright install chromium"
        ) from exc

    merged_headers = {**BROWSER_HEADERS, **(extra_headers or {})}
    start = time.monotonic()

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(
                user_agent=BROWSER_UA,
                extra_http_headers=merged_headers,
                viewport={"width": 1920, "height": 1080},
                locale="en-US",
            )
            # Inject stealth script before any page script runs
            context.add_init_script(STEALTH_JS)
            context.route("**/*", _guard_playwright_route)
            page = context.new_page()
            response = page.goto(
                url, wait_until=wait_until, timeout=int(timeout * 1000)
            )
            content = page.content()
            status_code = response.status if response is not None else 0
            response_headers = dict(response.headers) if response is not None else {}
            context.close()
            browser.close()

            elapsed_ms = (time.monotonic() - start) * 1000
            return FetchResult(
                url=url,
                content=content,
                status_code=status_code,
                elapsed_ms=elapsed_ms,
                method_used="crawl",
                headers=response_headers,
            )
    except CrawlError:
        raise
    except Exception as exc:
        elapsed_ms = (time.monotonic() - start) * 1000
        logger.warning("playwright_fetch failed for %s: %s", url, exc)
        return FetchResult(
            url=url,
            content="",
            status_code=0,
            elapsed_ms=elapsed_ms,
            method_used="crawl",
            error=str(exc),
        )


def api_fetch(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    timeout: float = 30.0,
) -> FetchResult:
    """Fetch a REST API endpoint using httpx (first tier: API).

    Unlike ``httpx_fetch``, this is for structured JSON API endpoints where
    we expect a JSON response. Headers default to a minimal API-style set
    (no Referer needed for API calls).

    Args:
        url: API endpoint URL.
        headers: Optional extra headers.
        timeout: Request timeout in seconds.

    Returns:
        FetchResult with the JSON response body as text.
    """
    _rate_limiter.wait()

    api_headers = {
        "User-Agent": BROWSER_UA,
        "Accept": "application/json",
    }
    if headers:
        api_headers.update(headers)

    start = time.monotonic()
    try:
        with httpx.Client(
            timeout=timeout,
            follow_redirects=True,
            event_hooks={"request": [validate_public_http_request]},
        ) as client:
            response = client.get(url, headers=api_headers)
            elapsed_ms = (time.monotonic() - start) * 1000
            return FetchResult(
                url=url,
                content=response.text,
                status_code=response.status_code,
                elapsed_ms=elapsed_ms,
                method_used="api",
                headers=dict(response.headers),
            )
    except Exception as exc:
        elapsed_ms = (time.monotonic() - start) * 1000
        logger.warning("api_fetch failed for %s: %s", url, exc)
        return FetchResult(
            url=url,
            content="",
            status_code=0,
            elapsed_ms=elapsed_ms,
            method_used="api",
            error=str(exc),
        )


def fetch_with_fallback(
    api_url: str | None,
    page_url: str,
    *,
    source_name: str = "unknown",
    use_crawl_fallback: bool = True,
    accept_result: Callable[[FetchResult], bool] | None = None,
) -> FetchResult:
    """Three-tier fallback fetch: api > httpx > crawl.

    Args:
        api_url: REST API endpoint URL (first tier). If None, skip API tier.
        page_url: Page URL for httpx and crawl tiers.
        source_name: Source name for logging.
        use_crawl_fallback: Whether to use Playwright as the final fallback.
        accept_result: Optional semantic acceptance predicate applied after a
            transport-successful result. Rejected results continue fallback.

    Returns:
        FetchResult from the first successful tier.

    Raises:
        CrawlError: If all tiers fail.
    """
    tried_methods: list[str] = []

    # Tier 1: API
    if api_url:
        logger.info("[%s] Tier 1 (API): fetching %s", source_name, api_url)
        result = api_fetch(api_url)
        tried_methods.append("api")
        if result.ok and (accept_result is None or accept_result(result)):
            logger.info("[%s] API tier succeeded (%.0fms)", source_name, result.elapsed_ms)
            return result
        logger.warning("[%s] API tier failed: %s", source_name, result.error or result.status_code)

    # Tier 2: httpx
    logger.info("[%s] Tier 2 (httpx): fetching %s", source_name, page_url)
    result = httpx_fetch(page_url)
    tried_methods.append("httpx")
    if result.ok and (accept_result is None or accept_result(result)):
        logger.info("[%s] httpx tier succeeded (%.0fms)", source_name, result.elapsed_ms)
        return result
    logger.warning("[%s] httpx tier failed: %s", source_name, result.error or result.status_code)

    # Tier 3: crawl (Playwright)
    if use_crawl_fallback:
        logger.info("[%s] Tier 3 (crawl): fetching %s", source_name, page_url)
        try:
            result = playwright_fetch(page_url)
            tried_methods.append("crawl")
            if result.ok and (accept_result is None or accept_result(result)):
                logger.info("[%s] crawl tier succeeded (%.0fms)", source_name, result.elapsed_ms)
                return result
            logger.warning(
                "[%s] crawl tier failed: %s",
                source_name,
                result.error or result.status_code,
            )
        except CrawlError as exc:
            logger.warning("[%s] crawl tier unavailable: %s", source_name, exc)
            tried_methods.append("crawl_failed")

    raise CrawlError(
        f"All fetch tiers failed for {source_name}. Tried: {', '.join(tried_methods)}"
    )
