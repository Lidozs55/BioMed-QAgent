"""Tests for the lifespan-owned asynchronous crawler facade."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, Mock

import app.tools.crawler as crawler_module
import httpx
import pytest
from app.tools.browser_pool import BrowserFetchResult
from app.tools.crawler import (
    BROWSER_HEADERS,
    AsyncHostRateLimiter,
    CrawlerFacade,
    CrawlError,
    FetchResult,
    fetch_with_fallback,
)
from app.tools.network_safety import PublicHttpTarget


class FakeCrawlerFacade:
    def __init__(
        self,
        *,
        api: FetchResult,
        html: FetchResult,
        browser: FetchResult,
    ) -> None:
        self.results = {"api": api, "html": html, "browser": browser}
        self.calls: list[str] = []

    async def api(self, _url: str) -> FetchResult:
        self.calls.append("api")
        return self.results["api"]

    async def html(self, _url: str) -> FetchResult:
        self.calls.append("html")
        return self.results["html"]

    async def browser(self, _url: str) -> FetchResult:
        self.calls.append("browser")
        return self.results["browser"]


def _result(
    method: str,
    *,
    status_code: int = 200,
    content: str = "ok",
    error: str | None = None,
) -> FetchResult:
    return FetchResult(
        url=f"https://{method}.example/data",
        content=content,
        status_code=status_code,
        elapsed_ms=1,
        method_used={"html": "httpx", "browser": "crawl"}.get(method, method),
        error=error,
    )


def _pinned_target(
    url: str,
    *,
    ip: str = "93.184.216.34",
) -> PublicHttpTarget:
    parsed = httpx.URL(url)
    return PublicHttpTarget(
        connect_url=str(parsed.copy_with(host=ip)),
        host_header=parsed.host,
        sni_hostname=parsed.host,
    )


@pytest.mark.asyncio
async def test_fallback_runs_api_then_html_then_browser_with_complete_audit() -> None:
    facade = FakeCrawlerFacade(
        api=_result("api", status_code=500, error="api failed"),
        html=_result("html", status_code=200, content="<div id='app'></div>"),
        browser=_result("browser", content="<p>rendered data</p>"),
    )

    result = await fetch_with_fallback(
        "https://api.example/data",
        "https://page.example/data",
        facade=facade,
        accept_result=lambda candidate: "rendered" in candidate.content,
    )

    assert facade.calls == ["api", "html", "browser"]
    assert [attempt.method for attempt in result.attempts] == [
        "api",
        "html",
        "browser",
    ]
    assert result.attempts[0].reason == "api failed"
    assert result.attempts[1].reason == "semantic acceptance predicate rejected result"


@pytest.mark.asyncio
async def test_fallback_stops_after_accepted_api_result() -> None:
    facade = FakeCrawlerFacade(
        api=_result("api", content='{"data": 1}'),
        html=_result("html"),
        browser=_result("browser"),
    )

    result = await fetch_with_fallback(
        "https://api.example/data",
        facade=facade,
    )

    assert result.method_used == "api"
    assert facade.calls == ["api"]


@pytest.mark.asyncio
async def test_fallback_fails_closed_without_run_bound_facade() -> None:
    with pytest.raises(CrawlError, match="not bound"):
        await fetch_with_fallback("https://api.example/data")


@pytest.mark.asyncio
async def test_fallback_reports_all_failed_tiers() -> None:
    facade = FakeCrawlerFacade(
        api=_result("api", status_code=500, error="api failed"),
        html=_result("html", status_code=500, error="html failed"),
        browser=_result("browser", status_code=500, error="browser failed"),
    )

    with pytest.raises(CrawlError) as caught:
        await fetch_with_fallback(
            "https://api.example/data",
            "https://page.example/data",
            facade=facade,
        )

    assert [attempt.method for attempt in caught.value.attempts] == [
        "api",
        "html",
        "browser",
    ]


@pytest.mark.asyncio
async def test_host_limiter_does_not_serialize_different_hosts() -> None:
    sleeping = asyncio.Event()
    release = asyncio.Event()

    async def sleep(_delay: float) -> None:
        sleeping.set()
        await release.wait()

    limiter = AsyncHostRateLimiter(
        min_interval=1,
        clock=lambda: 0,
        sleeper=sleep,
    )
    await limiter.wait("https://host-a.example/first")
    same_host = asyncio.create_task(limiter.wait("https://HOST-A.example/second"))
    await sleeping.wait()
    other_host = asyncio.create_task(limiter.wait("https://host-b.example/first"))
    await asyncio.sleep(0)

    assert other_host.done()
    assert not same_host.done()
    release.set()
    await same_host


@pytest.mark.asyncio
async def test_host_limiter_bounds_one_off_host_state() -> None:
    limiter = AsyncHostRateLimiter(min_interval=0, max_hosts=4)
    for index in range(20):
        await limiter.wait(f"https://host-{index}.example/data")
    assert limiter.tracked_host_count == 4


@pytest.mark.asyncio
async def test_crawler_pins_single_resolution_and_preserves_host_and_sni() -> None:
    resolutions = iter(["93.184.216.34", "127.0.0.1"])
    resolved: list[str] = []
    transported: list[tuple[str, str, str]] = []

    async def resolve(url: str) -> PublicHttpTarget:
        resolved.append(url)
        return _pinned_target(url, ip=next(resolutions))

    def handler(request: httpx.Request) -> httpx.Response:
        transported.append(
            (
                str(request.url),
                request.headers["host"],
                request.extensions["sni_hostname"],
            )
        )
        return httpx.Response(200, content=b"ok")

    facade = CrawlerFacade(
        min_interval=0,
        http_transport=httpx.MockTransport(handler),
        target_resolver=resolve,
    )
    result = await facade.api("https://public.example/data")
    await facade.aclose()

    assert result.ok
    assert resolved == ["https://public.example/data"]
    assert transported == [("https://93.184.216.34/data", "public.example", "public.example")]


@pytest.mark.asyncio
async def test_crawler_revalidates_redirect_before_transport() -> None:
    resolved: list[str] = []
    transported: list[str] = []

    async def resolve(url: str) -> PublicHttpTarget:
        resolved.append(url)
        if "private.example" in url:
            raise ValueError("private redirect denied")
        return _pinned_target(url)

    def handler(request: httpx.Request) -> httpx.Response:
        transported.append(str(request.url))
        return httpx.Response(
            302,
            headers={"location": "https://private.example/secret"},
        )

    facade = CrawlerFacade(
        min_interval=0,
        http_transport=httpx.MockTransport(handler),
        target_resolver=resolve,
    )
    result = await facade.api("https://public.example/data")
    await facade.aclose()

    assert "private redirect denied" in (result.error or "")
    assert resolved == [
        "https://public.example/data",
        "https://private.example/secret",
    ]
    assert transported == ["https://93.184.216.34/data"]


@pytest.mark.asyncio
async def test_html_and_browser_tiers_share_the_same_host_limiter() -> None:
    sleeps: list[float] = []

    async def sleep(delay: float) -> None:
        sleeps.append(delay)

    browser_pool = Mock()
    browser_pool.fetch = AsyncMock(
        return_value=BrowserFetchResult(
            url="https://host-a.example/page",
            content="<html>rendered</html>",
            status_code=200,
            elapsed_ms=1,
            headers={},
        )
    )
    facade = CrawlerFacade(
        browser_pool=browser_pool,
        min_interval=0,
        http_transport=httpx.MockTransport(
            lambda _request: httpx.Response(200, content=b"<html>static</html>")
        ),
        target_resolver=lambda url: asyncio.sleep(0, result=_pinned_target(url)),
    )
    facade._limiter = AsyncHostRateLimiter(
        min_interval=1,
        clock=lambda: 0,
        sleeper=sleep,
    )

    await facade.html("https://host-a.example/page")
    await facade.browser("https://host-a.example/page")
    await facade.browser("https://host-b.example/page")
    await facade.aclose()

    assert sleeps == [1]


@pytest.mark.asyncio
async def test_crawler_rejects_oversized_response_and_download(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(crawler_module, "MAX_CRAWLER_RESPONSE_BYTES", 8)
    monkeypatch.setattr(crawler_module, "MAX_CRAWLER_DOWNLOAD_BYTES", 8)
    facade = CrawlerFacade(
        min_interval=0,
        http_transport=httpx.MockTransport(
            lambda _request: httpx.Response(200, content=b"123456789")
        ),
        target_resolver=lambda url: asyncio.sleep(0, result=_pinned_target(url)),
    )

    text = await facade.html("https://public.example/data")
    binary = await facade.download("https://public.example/data")
    await facade.aclose()

    assert text.error == "crawler response exceeded 8 byte limit"
    assert binary.error == "crawler download exceeded 8 byte limit"


def test_browser_headers_contain_required_fields() -> None:
    assert "Chrome" in BROWSER_HEADERS["User-Agent"]
    assert "Referer" in BROWSER_HEADERS
    assert "Accept" in BROWSER_HEADERS
