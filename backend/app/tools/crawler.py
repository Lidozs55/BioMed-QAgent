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

import asyncio
import logging
import threading
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlsplit

import httpx

from app.tools.browser_pool import BrowserPool
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
MAX_CRAWLER_RESPONSE_BYTES = 10 * 1024 * 1024


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
    attempts: tuple[CrawlAttempt, ...] = ()

    @property
    def ok(self) -> bool:
        return 200 <= self.status_code < 300 and self.error is None


@dataclass(frozen=True, slots=True)
class CrawlAttempt:
    """One auditable API, HTML, or browser acquisition attempt."""

    method: str
    url: str
    started_at: datetime
    status: str
    status_code: int | None = None
    reason: str | None = None
    fallback_reason: str | None = None


class CrawlError(Exception):
    """Raised when all fetch methods fail."""

    def __init__(
        self,
        message: str,
        *,
        attempts: tuple[CrawlAttempt, ...] = (),
    ) -> None:
        super().__init__(message)
        self.attempts = attempts


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


@dataclass(slots=True)
class _AsyncHostState:
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    last_request_time: float | None = None
    last_used: float = 0.0
    references: int = 0


class AsyncHostRateLimiter:
    """Apply request pacing independently for each normalized hostname."""

    def __init__(
        self,
        *,
        min_interval: float = _RATE_LIMIT_SECONDS,
        max_hosts: int = 256,
        clock: Callable[[], float] = time.monotonic,
        sleeper: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        if min_interval < 0:
            raise ValueError("min_interval must be non-negative")
        if max_hosts <= 0:
            raise ValueError("max_hosts must be positive")
        self._min_interval = min_interval
        self._max_hosts = max_hosts
        self._clock = clock
        self._sleeper = sleeper
        self._hosts: dict[str, _AsyncHostState] = {}
        self._registry_lock = asyncio.Lock()

    @property
    def tracked_host_count(self) -> int:
        return len(self._hosts)

    async def wait(self, url: str) -> None:
        """Wait for the limiter associated with *url*'s hostname."""
        host = _normalized_host(url)
        async with self._registry_lock:
            state = self._hosts.get(host)
            if state is None:
                self._evict_idle_host()
                state = _AsyncHostState()
                self._hosts[host] = state
            state.references += 1
            state.last_used = self._clock()
        try:
            async with state.lock:
                now = self._clock()
                if state.last_request_time is not None:
                    remaining = self._min_interval - (now - state.last_request_time)
                    if remaining > 0:
                        await self._sleeper(remaining)
                state.last_request_time = self._clock()
        finally:
            async with self._registry_lock:
                state.references -= 1
                state.last_used = self._clock()

    def _evict_idle_host(self) -> None:
        if len(self._hosts) < self._max_hosts:
            return
        candidates = [
            (state.last_used, host) for host, state in self._hosts.items() if state.references == 0
        ]
        if not candidates:
            raise RuntimeError("host rate limiter capacity is exhausted")
        _, oldest_host = min(candidates)
        del self._hosts[oldest_host]


class CrawlerFacadeProtocol(Protocol):
    """I/O surface consumed by the deterministic fallback orchestrator."""

    async def api(self, url: str) -> FetchResult: ...

    async def html(self, url: str) -> FetchResult: ...

    async def browser(self, url: str) -> FetchResult: ...


class CrawlerFacade:
    """Asynchronous API/HTML/browser transports with host-scoped limiting."""

    def __init__(
        self,
        *,
        browser_pool: BrowserPool | None = None,
        min_interval: float = _RATE_LIMIT_SECONDS,
        http_transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._browser_pool = browser_pool
        self._limiter = AsyncHostRateLimiter(min_interval=min_interval)
        self._http = httpx.AsyncClient(
            timeout=30.0,
            follow_redirects=True,
            trust_env=False,
            transport=http_transport,
            event_hooks={"request": [self._before_request]},
        )
        self._closed = False

    async def api(self, url: str) -> FetchResult:
        """Fetch structured API content."""
        return await self._request(
            url,
            headers={
                "User-Agent": BROWSER_UA,
                "Accept": "application/json",
            },
            method_used="api",
        )

    async def html(self, url: str) -> FetchResult:
        """Fetch static HTML content."""
        return await self._request(
            url,
            headers=BROWSER_HEADERS,
            method_used="httpx",
        )

    async def browser(self, url: str) -> FetchResult:
        """Render content through the lifespan-owned BrowserPool."""
        if self._browser_pool is None:
            return FetchResult(
                url=url,
                content="",
                status_code=0,
                elapsed_ms=0,
                method_used="crawl",
                error="lifespan-owned browser pool is unavailable",
            )
        started_at = time.monotonic()
        try:
            result = await self._browser_pool.fetch(
                url,
                extra_headers=BROWSER_HEADERS,
            )
            return FetchResult(
                url=result.url,
                content=result.content,
                status_code=result.status_code,
                elapsed_ms=result.elapsed_ms,
                method_used="crawl",
                headers=result.headers,
            )
        except Exception as error:
            return FetchResult(
                url=url,
                content="",
                status_code=0,
                elapsed_ms=(time.monotonic() - started_at) * 1000,
                method_used="crawl",
                error=f"{type(error).__name__}: {error}",
            )

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        await self._http.aclose()

    async def _before_request(self, request: httpx.Request) -> None:
        url = str(request.url)
        await asyncio.to_thread(validate_public_http_url, url)
        await self._limiter.wait(url)

    async def _request(
        self,
        url: str,
        *,
        headers: dict[str, str],
        method_used: str,
    ) -> FetchResult:
        started_at = time.monotonic()
        try:
            async with self._http.stream(
                "GET",
                url,
                headers=headers,
            ) as response:
                declared_length = response.headers.get(
                    "content-length",
                    "",
                ).strip()
                if declared_length.isdigit() and int(declared_length) > MAX_CRAWLER_RESPONSE_BYTES:
                    return self._oversized_result(
                        url=str(response.url),
                        status_code=response.status_code,
                        elapsed_ms=(time.monotonic() - started_at) * 1000,
                        method_used=method_used,
                        headers=dict(response.headers),
                    )
                chunks: list[bytes] = []
                received = 0
                async for chunk in response.aiter_bytes():
                    received += len(chunk)
                    if received > MAX_CRAWLER_RESPONSE_BYTES:
                        return self._oversized_result(
                            url=str(response.url),
                            status_code=response.status_code,
                            elapsed_ms=(time.monotonic() - started_at) * 1000,
                            method_used=method_used,
                            headers=dict(response.headers),
                        )
                    chunks.append(chunk)
                encoding = response.encoding or "utf-8"
                content = b"".join(chunks).decode(
                    encoding,
                    errors="replace",
                )
                return FetchResult(
                    url=str(response.url),
                    content=content,
                    status_code=response.status_code,
                    elapsed_ms=(time.monotonic() - started_at) * 1000,
                    method_used=method_used,
                    headers=dict(response.headers),
                )
        except Exception as error:
            return FetchResult(
                url=url,
                content="",
                status_code=0,
                elapsed_ms=(time.monotonic() - started_at) * 1000,
                method_used=method_used,
                error=f"{type(error).__name__}: {error}",
            )

    @staticmethod
    def _oversized_result(
        *,
        url: str,
        status_code: int,
        elapsed_ms: float,
        method_used: str,
        headers: dict[str, str],
    ) -> FetchResult:
        return FetchResult(
            url=url,
            content="",
            status_code=status_code,
            elapsed_ms=elapsed_ms,
            method_used=method_used,
            headers=headers,
            error=(f"crawler response exceeded {MAX_CRAWLER_RESPONSE_BYTES} byte limit"),
        )


_default_crawler_facade: CrawlerFacade | None = None


def set_default_crawler_facade(facade: CrawlerFacade | None) -> None:
    """Configure the facade owned by the application lifespan."""
    global _default_crawler_facade
    _default_crawler_facade = facade


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
            response = page.goto(url, wait_until=wait_until, timeout=int(timeout * 1000))
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


@dataclass
class ScreenshotResult:
    """Result of a screenshot capture operation."""

    url: str
    path: Path
    status_code: int
    elapsed_ms: float
    viewport_width: int
    viewport_height: int
    full_page: bool
    selector: str | None
    error: str | None = None

    @property
    def ok(self) -> bool:
        return 200 <= self.status_code < 300 and self.error is None


def playwright_screenshot(
    url: str,
    *,
    dest_path: Path,
    full_page: bool = True,
    viewport_width: int = 1920,
    viewport_height: int = 1080,
    wait_until: str = "networkidle",
    timeout: float = 60.0,
    selector: str | None = None,
    extra_headers: dict[str, str] | None = None,
) -> ScreenshotResult:
    """Capture a web page screenshot using Playwright Chromium with stealth.

    Mirrors ``playwright_fetch`` stealth/UA/rate-limit behavior but captures a
    PNG screenshot instead of returning HTML. Saves to ``dest_path`` (which
    must be inside the task workdir for path safety).

    Args:
        url: Target URL.
        dest_path: Destination PNG path (caller is responsible for path safety).
        full_page: Whether to capture the full scrollable page.
        viewport_width: Browser viewport width in pixels (max 1920).
        viewport_height: Browser viewport height in pixels (max 1080).
        wait_until: Playwright wait strategy.
        timeout: Navigation timeout in seconds.
        selector: Optional CSS selector; if given, captures only that element.
        extra_headers: Optional extra headers.

    Returns:
        ScreenshotResult with capture metadata.

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

    # Clamp viewport to hard上限 (project_memory: 避免内存爆炸)
    vw = min(viewport_width, 1920)
    vh = min(viewport_height, 1080)

    merged_headers = {**BROWSER_HEADERS, **(extra_headers or {})}
    start = time.monotonic()

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(
                user_agent=BROWSER_UA,
                extra_http_headers=merged_headers,
                viewport={"width": vw, "height": vh},
                locale="en-US",
            )
            context.add_init_script(STEALTH_JS)
            context.route("**/*", _guard_playwright_route)
            page = context.new_page()
            response = page.goto(url, wait_until=wait_until, timeout=int(timeout * 1000))
            status_code = response.status if response is not None else 0

            dest_path.parent.mkdir(parents=True, exist_ok=True)
            if selector:
                # Wait for the element to be visible before截图; otherwise
                # bounding_box() may return None on pages with slow layout
                # (images/fonts loading, ads shifting the viewport).
                page.wait_for_selector(selector, state="visible", timeout=int(timeout * 1000))
                locator = page.locator(selector).first
                # Use JS scrollIntoView to bypass Playwright's "waiting for
                # element to be stable" check, which hangs on pages with
                # sticky elements (Wikipedia's sticky header) or continuous
                # layout shifts (BMC's lazy-loaded figures). The built-in
                # locator.scroll_into_view_if_needed() and locator.screenshot()
                # both internally wait for stability and can time out.
                locator.evaluate("el => el.scrollIntoView({block: 'center', inline: 'center'})")
                # Allow layout to settle briefly after the JS scroll
                page.wait_for_timeout(300)
                bbox = locator.bounding_box()
                if bbox is None:
                    raise CrawlError(f"Element '{selector}' has no bounding box on {url}")
                # Clip the page screenshot to the element's bounding box.
                # page.screenshot(clip=...) does NOT do element stability
                # checks, so it won't hang on continuous layout shifts.
                page.screenshot(
                    path=str(dest_path),
                    clip={
                        "x": max(0.0, bbox["x"]),
                        "y": max(0.0, bbox["y"]),
                        "width": bbox["width"],
                        "height": bbox["height"],
                    },
                    timeout=int(timeout * 1000),
                )
            else:
                page.screenshot(
                    path=str(dest_path),
                    full_page=full_page,
                    timeout=int(timeout * 1000),
                )
            context.close()
            browser.close()

            elapsed_ms = (time.monotonic() - start) * 1000
            return ScreenshotResult(
                url=url,
                path=dest_path,
                status_code=status_code,
                elapsed_ms=elapsed_ms,
                viewport_width=vw,
                viewport_height=vh,
                full_page=full_page,
                selector=selector,
            )
    except CrawlError:
        raise
    except Exception as exc:
        elapsed_ms = (time.monotonic() - start) * 1000
        logger.warning("playwright_screenshot failed for %s: %s", url, exc)
        return ScreenshotResult(
            url=url,
            path=dest_path,
            status_code=0,
            elapsed_ms=elapsed_ms,
            viewport_width=vw,
            viewport_height=vh,
            full_page=full_page,
            selector=selector,
            error=str(exc),
        )


async def fetch_with_fallback(
    api_url: str | None,
    page_url: str | None = None,
    *,
    source_name: str = "unknown",
    use_crawl_fallback: bool = True,
    accept_result: Callable[[FetchResult], bool] | None = None,
    facade: CrawlerFacadeProtocol | None = None,
) -> FetchResult:
    """Run the exact API → HTML → browser fallback sequence.

    Args:
        api_url: REST API endpoint URL (first tier). If None, skip API tier.
        page_url: Page URL for HTML and browser tiers. When omitted, ``api_url``
            is used for all three tiers.
        source_name: Source name for logging.
        use_crawl_fallback: Whether to use Playwright as the final fallback.
        accept_result: Optional semantic acceptance predicate applied after a
            transport-successful result. Rejected results continue fallback.
        facade: Optional injected asynchronous transports.

    Returns:
        The first accepted FetchResult with its complete attempt audit.

    Raises:
        CrawlError: If all tiers fail.
    """
    if page_url is None:
        if api_url is None:
            raise ValueError("api_url or page_url is required")
        page_url = api_url

    active_facade = facade or _default_crawler_facade
    owns_facade = active_facade is None
    if active_facade is None:
        active_facade = CrawlerFacade()

    attempts: list[CrawlAttempt] = []
    tiers: list[
        tuple[
            str,
            str,
            Callable[[str], Awaitable[FetchResult]],
        ]
    ] = []
    if api_url is not None:
        tiers.append(("api", api_url, active_facade.api))
    tiers.append(("html", page_url, active_facade.html))
    if use_crawl_fallback:
        tiers.append(("browser", page_url, active_facade.browser))

    try:
        for tier_index, (method, url, operation) in enumerate(tiers):
            logger.info(
                "[%s] %s tier: fetching %s",
                source_name,
                method,
                url,
            )
            started_at = datetime.now(UTC)
            try:
                result = await operation(url)
            except Exception as error:
                result = FetchResult(
                    url=url,
                    content="",
                    status_code=0,
                    elapsed_ms=0,
                    method_used=_legacy_method_name(method),
                    error=f"{type(error).__name__}: {error}",
                )

            accepted = result.ok
            if accepted and accept_result is not None:
                accepted = await asyncio.to_thread(
                    accept_result,
                    result,
                )
            reason = _attempt_reason(result, accepted=accepted)
            attempts.append(
                CrawlAttempt(
                    method=method,
                    url=url,
                    started_at=started_at,
                    status="succeeded" if accepted else "failed",
                    status_code=(result.status_code if result.status_code > 0 else None),
                    reason=reason,
                    fallback_reason=(
                        f"falling back to {tiers[tier_index + 1][0]}"
                        if not accepted and tier_index + 1 < len(tiers)
                        else None
                    ),
                )
            )
            if accepted:
                result.attempts = tuple(attempts)
                return result
            logger.warning(
                "[%s] %s tier failed: %s",
                source_name,
                method,
                reason,
            )
    finally:
        if owns_facade:
            assert isinstance(active_facade, CrawlerFacade)
            await active_facade.aclose()

    raise CrawlError(
        f"All fetch tiers failed for {source_name}. "
        f"Tried: {', '.join(attempt.method for attempt in attempts)}",
        attempts=tuple(attempts),
    )


def _attempt_reason(result: FetchResult, *, accepted: bool) -> str | None:
    if accepted:
        return None
    if result.error:
        return result.error
    if result.ok:
        return "semantic acceptance predicate rejected result"
    if result.status_code:
        return f"HTTP {result.status_code}"
    return "transport returned no successful response"


def _legacy_method_name(method: str) -> str:
    return {"html": "httpx", "browser": "crawl"}.get(method, method)


def _normalized_host(url: str) -> str:
    try:
        host = urlsplit(url).hostname
    except ValueError as error:
        raise ValueError("rate-limited URL is malformed") from error
    if not host:
        raise ValueError("rate-limited URL requires a hostname")
    return host.lower().rstrip(".")
