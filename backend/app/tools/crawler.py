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
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Protocol
from urllib.parse import urljoin, urlsplit

import httpx

from app.domain.contracts import DataLevel
from app.model_settings import get_runtime_limits
from app.subagents.staging import SubagentStagingWorkspace
from app.tools.browser_pool import (
    BROWSER_UA,
    BrowserPool,
    BrowserRequestAuthorizer,
    BrowserScreenshotResult,
)
from app.tools.network_safety import (
    PublicHttpTarget,
    resolve_public_http_target,
)

logger = logging.getLogger(__name__)

# Default headers for all requests (project_memory L11: Referer + Accept required)
BROWSER_HEADERS: dict[str, str] = {
    "User-Agent": BROWSER_UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
    "Referer": "https://www.google.com/",
}

# Rate limiting: 2s between requests (project_memory L11)
DEFAULT_RATE_LIMIT_SECONDS = 2.0
MAX_CRAWLER_RESPONSE_BYTES = 10 * 1024 * 1024
MAX_CRAWLER_DOWNLOAD_BYTES = 4096 * 1024 * 1024  # 4 GiB: dataset-scale file downloads
MAX_CRAWLER_REDIRECTS = 10


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
class DownloadResult:
    """Bounded binary response downloaded through the pinned crawler transport."""

    url: str
    content: bytes
    status_code: int
    elapsed_ms: float
    headers: dict[str, str] = field(default_factory=dict)
    error: str | None = None

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


@dataclass(slots=True)
class _AsyncHostState:
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    last_request_time: float | None = None
    last_used: float = 0.0
    references: int = 0


class AsyncHostRateLimiter:
    """Apply request pacing independently for each normalized hostname.

    This is the project's single rate-limiter implementation (REVIEW
    2026-08-05 §5.3); acquisition/download paths must route pacing through
    it instead of maintaining private limiter copies.
    """

    def __init__(
        self,
        *,
        min_interval: float = DEFAULT_RATE_LIMIT_SECONDS,
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
    def min_interval(self) -> float:
        return self._min_interval

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

    async def api_request(
        self,
        url: str,
        *,
        method: str = "GET",
        json_body: dict[str, object] | None = None,
        raw_body: str | None = None,
    ) -> FetchResult: ...

    async def html(self, url: str) -> FetchResult: ...

    async def browser(self, url: str) -> FetchResult: ...

    async def download(self, url: str) -> DownloadResult: ...


class CrawlerFacade:
    """Asynchronous API/HTML/browser transports with host-scoped limiting."""

    def __init__(
        self,
        *,
        browser_pool: BrowserPool | None = None,
        min_interval: float = DEFAULT_RATE_LIMIT_SECONDS,
        http_transport: httpx.AsyncBaseTransport | None = None,
        target_resolver: Callable[[str], Awaitable[PublicHttpTarget]] | None = None,
    ) -> None:
        self._browser_pool = browser_pool
        self._limiter = AsyncHostRateLimiter(min_interval=min_interval)
        self._target_resolver = target_resolver or _resolve_public_target
        self._http_transport = http_transport
        self._closed = False

    async def api(self, url: str) -> FetchResult:
        """Fetch structured API content."""
        return await self.api_request(url)

    async def api_request(
        self,
        url: str,
        *,
        method: str = "GET",
        json_body: dict[str, object] | None = None,
        raw_body: str | None = None,
    ) -> FetchResult:
        """Send one pinned API request without following redirects.

        ``json_body`` sends a JSON payload (Content-Type: application/json);
        ``raw_body`` sends a raw string payload (Content-Type: text/plain),
        used for plain-text query APIs such as the UCSC Xena hub ``/data/``
        endpoint. ``json_body`` and ``raw_body`` are mutually exclusive.
        """

        normalized_method = method.upper().strip()
        if normalized_method not in {"GET", "POST"}:
            raise ValueError("crawler API method must be GET or POST")
        if json_body is not None and raw_body is not None:
            raise ValueError("crawler API body must be either JSON or raw text, not both")
        content_type = "text/plain" if raw_body is not None else "application/json"
        return await self._request(
            url,
            headers={
                "User-Agent": BROWSER_UA,
                "Accept": "application/json",
                "Content-Type": content_type,
            },
            method_used="api",
            method=normalized_method,
            json_body=json_body,
            raw_body=raw_body,
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
        if self._closed:
            return FetchResult(
                url=url,
                content="",
                status_code=0,
                elapsed_ms=0,
                method_used="crawl",
                error="crawler facade is closed",
            )
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
            await self._limiter.wait(url)
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

    async def download(self, url: str) -> DownloadResult:
        """Download bounded binary content through the pinned HTTP path."""

        started_at = time.monotonic()
        current_url = url
        try:
            for redirect_count in range(MAX_CRAWLER_REDIRECTS + 1):
                pinned = await self._target_resolver(current_url)
                await self._limiter.wait(current_url)
                async with self._open_http_client() as http:
                    request = http.build_request(
                        "GET",
                        pinned.connect_url,
                        headers={
                            **BROWSER_HEADERS,
                            "Host": pinned.host_header,
                        },
                        extensions={"sni_hostname": pinned.sni_hostname},
                    )
                    response = await http.send(
                        request,
                        follow_redirects=False,
                        stream=True,
                    )
                    try:
                        result = await self._download_response(
                            response=response,
                            current_url=current_url,
                            started_at=started_at,
                            redirect_count=redirect_count,
                        )
                    finally:
                        await response.aclose()
                if isinstance(result, str):
                    current_url = urljoin(current_url, result)
                    continue
                return result
            raise AssertionError("redirect loop must return before exhaustion")
        except Exception as error:
            return DownloadResult(
                url=current_url,
                content=b"",
                status_code=0,
                elapsed_ms=(time.monotonic() - started_at) * 1000,
                error=f"{type(error).__name__}: {error}",
            )

    async def _download_response(
        self,
        *,
        response: httpx.Response,
        current_url: str,
        started_at: float,
        redirect_count: int,
    ) -> DownloadResult | str:
        if 300 <= response.status_code < 400:
            location = response.headers.get("location")
            if not location:
                return DownloadResult(
                    url=current_url,
                    content=b"",
                    status_code=response.status_code,
                    elapsed_ms=(time.monotonic() - started_at) * 1000,
                    headers=dict(response.headers),
                    error="redirect response missing Location header",
                )
            if redirect_count >= MAX_CRAWLER_REDIRECTS:
                return DownloadResult(
                    url=current_url,
                    content=b"",
                    status_code=response.status_code,
                    elapsed_ms=(time.monotonic() - started_at) * 1000,
                    headers=dict(response.headers),
                    error=f"crawler exceeded {MAX_CRAWLER_REDIRECTS} redirects",
                )
            return location
        declared_length = response.headers.get("content-length", "").strip()
        if declared_length.isdigit() and int(declared_length) > MAX_CRAWLER_DOWNLOAD_BYTES:
            return self._oversized_download_result(
                url=current_url,
                status_code=response.status_code,
                elapsed_ms=(time.monotonic() - started_at) * 1000,
                headers=dict(response.headers),
            )
        chunks: list[bytes] = []
        received = 0
        async for chunk in response.aiter_bytes():
            received += len(chunk)
            if received > MAX_CRAWLER_DOWNLOAD_BYTES:
                return self._oversized_download_result(
                    url=current_url,
                    status_code=response.status_code,
                    elapsed_ms=(time.monotonic() - started_at) * 1000,
                    headers=dict(response.headers),
                )
            chunks.append(chunk)
        return DownloadResult(
            url=current_url,
            content=b"".join(chunks),
            status_code=response.status_code,
            elapsed_ms=(time.monotonic() - started_at) * 1000,
            headers=dict(response.headers),
        )

    async def screenshot(
        self,
        url: str,
        *,
        workspace: SubagentStagingWorkspace,
        filename: str,
        source_id: str,
        successful_attempt_id: str,
        data_level: DataLevel,
        authorize_request: BrowserRequestAuthorizer | None = None,
        full_page: bool = True,
        selector: str | None = None,
        viewport_width: int = 1920,
        viewport_height: int = 1080,
        wait_until: str = "networkidle",
        timeout: float = 60.0,
        extra_headers: dict[str, str] | None = None,
    ) -> BrowserScreenshotResult:
        """Capture through the shared limiter and lifespan-owned BrowserPool."""

        if self._closed:
            raise RuntimeError("crawler facade is closed")
        if self._browser_pool is None:
            raise RuntimeError("lifespan-owned browser pool is unavailable")
        await self._limiter.wait(url)
        return await self._browser_pool.screenshot(
            url,
            workspace=workspace,
            filename=filename,
            source_id=source_id,
            successful_attempt_id=successful_attempt_id,
            data_level=data_level,
            authorize_request=authorize_request,
            full_page=full_page,
            selector=selector,
            viewport_width=viewport_width,
            viewport_height=viewport_height,
            wait_until=wait_until,
            timeout=timeout,
            extra_headers=extra_headers,
        )

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True

    async def _request(
        self,
        url: str,
        *,
        headers: dict[str, str],
        method_used: str,
        method: str = "GET",
        json_body: dict[str, object] | None = None,
        raw_body: str | None = None,
    ) -> FetchResult:
        started_at = time.monotonic()
        current_url = url
        try:
            for redirect_count in range(MAX_CRAWLER_REDIRECTS + 1):
                pinned = await self._target_resolver(current_url)
                await self._limiter.wait(current_url)
                request_headers = {
                    name: value for name, value in headers.items() if name.lower() != "host"
                }
                request_headers["Host"] = pinned.host_header
                async with self._open_http_client() as http:
                    if raw_body is not None:
                        request = http.build_request(
                            method,
                            pinned.connect_url,
                            headers=request_headers,
                            content=raw_body.encode("utf-8"),
                            extensions={"sni_hostname": pinned.sni_hostname},
                        )
                    else:
                        request = http.build_request(
                            method,
                            pinned.connect_url,
                            headers=request_headers,
                            json=json_body,
                            extensions={"sni_hostname": pinned.sni_hostname},
                        )
                    response = await http.send(
                        request,
                        follow_redirects=False,
                        stream=True,
                    )
                    try:
                        result = await self._text_response(
                            response=response,
                            current_url=current_url,
                            started_at=started_at,
                            redirect_count=redirect_count,
                            method_used=method_used,
                        )
                    finally:
                        await response.aclose()
                if isinstance(result, str):
                    current_url = urljoin(current_url, result)
                    continue
                return result
            raise AssertionError("redirect loop must return before exhaustion")
        except Exception as error:
            return FetchResult(
                url=current_url,
                content="",
                status_code=0,
                elapsed_ms=(time.monotonic() - started_at) * 1000,
                method_used=method_used,
                error=f"{type(error).__name__}: {error}",
            )

    async def _text_response(
        self,
        *,
        response: httpx.Response,
        current_url: str,
        started_at: float,
        redirect_count: int,
        method_used: str,
    ) -> FetchResult | str:
        if 300 <= response.status_code < 400:
            location = response.headers.get("location")
            if not location:
                return FetchResult(
                    url=current_url,
                    content="",
                    status_code=response.status_code,
                    elapsed_ms=(time.monotonic() - started_at) * 1000,
                    method_used=method_used,
                    headers=dict(response.headers),
                    error="redirect response missing Location header",
                )
            if redirect_count >= MAX_CRAWLER_REDIRECTS:
                return FetchResult(
                    url=current_url,
                    content="",
                    status_code=response.status_code,
                    elapsed_ms=(time.monotonic() - started_at) * 1000,
                    method_used=method_used,
                    headers=dict(response.headers),
                    error=f"crawler exceeded {MAX_CRAWLER_REDIRECTS} redirects",
                )
            return location

        declared_length = response.headers.get(
            "content-length",
            "",
        ).strip()
        if declared_length.isdigit() and int(declared_length) > MAX_CRAWLER_RESPONSE_BYTES:
            return self._oversized_result(
                url=current_url,
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
                    url=current_url,
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
            url=current_url,
            content=content,
            status_code=response.status_code,
            elapsed_ms=(time.monotonic() - started_at) * 1000,
            method_used=method_used,
            headers=dict(response.headers),
        )

    def _open_http_client(self) -> httpx.AsyncClient:
        if self._closed:
            raise RuntimeError("crawler facade is closed")
        return httpx.AsyncClient(
            timeout=get_runtime_limits().http_timeout_seconds,
            follow_redirects=False,
            trust_env=False,
            transport=self._http_transport,
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

    @staticmethod
    def _oversized_download_result(
        *,
        url: str,
        status_code: int,
        elapsed_ms: float,
        headers: dict[str, str],
    ) -> DownloadResult:
        return DownloadResult(
            url=url,
            content=b"",
            status_code=status_code,
            elapsed_ms=elapsed_ms,
            headers=headers,
            error=f"crawler download exceeded {MAX_CRAWLER_DOWNLOAD_BYTES} byte limit",
        )


async def _resolve_public_target(url: str) -> PublicHttpTarget:
    return await asyncio.to_thread(
        resolve_public_http_target,
        url,
        require_https=False,
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

    if facade is None:
        raise CrawlError("crawler facade is not bound to the current Run")
    active_facade = facade

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
