"""Tests for the unified crawler layer — crawler.py.

Tests the three-tier fallback chain (api > httpx > crawl) and rate limiter.
"""

from __future__ import annotations

import asyncio
import threading
import time
from unittest.mock import MagicMock, patch

import app.tools.crawler as crawler_module
import httpx
import pytest
from app.tools.crawler import (
    BROWSER_HEADERS,
    BROWSER_UA,
    STEALTH_JS,
    AsyncHostRateLimiter,
    CrawlerFacade,
    CrawlError,
    FetchResult,
    RateLimiter,
    api_fetch,
    fetch_with_fallback,
    httpx_fetch,
    playwright_fetch,
)
from app.tools.network_safety import validate_public_http_request

# ---------------------------------------------------------------------------
# Fixtures — rate limiter is disabled globally in conftest.py
# ---------------------------------------------------------------------------


def _mock_httpx_response(
    text: str = "",
    status_code: int = 200,
    headers: dict[str, str] | None = None,
) -> MagicMock:
    """Build a mock httpx.Response object."""
    resp = MagicMock()
    resp.status_code = status_code
    resp.text = text
    resp.headers = headers or {}
    return resp


def _mock_httpx_client(response: MagicMock) -> MagicMock:
    """Build a mock httpx.Client context manager."""
    client = MagicMock()
    client.get.return_value = response
    client.__enter__.return_value = client
    client.__exit__.return_value = False
    return client


# ---------------------------------------------------------------------------
# RateLimiter
# ---------------------------------------------------------------------------


def test_rate_limiter_waits_between_requests() -> None:
    """RateLimiter.wait() sleeps when called within the min interval."""
    limiter = RateLimiter(min_interval=0.1)
    with patch("app.tools.crawler.time.sleep") as mock_sleep:
        # First call: no sleep (last_request_time is 0.0)
        limiter.wait()
        # Reset last_request_time to force sleep on second call
        limiter._last_request_time = 1e9  # far future
        limiter.wait()
        mock_sleep.assert_called_once()


def test_rate_limiter_no_wait_after_interval() -> None:
    """RateLimiter.wait() does not sleep if interval has elapsed."""
    limiter = RateLimiter(min_interval=0.1)
    limiter._last_request_time = 0.0  # long time ago
    with patch("app.tools.crawler.time.sleep") as mock_sleep:
        limiter.wait()
        mock_sleep.assert_not_called()


def test_rate_limiter_serializes_concurrent_callers() -> None:
    limiter = RateLimiter(min_interval=0.05)
    barrier = threading.Barrier(3)
    completed_at: list[float] = []

    def wait_once() -> None:
        barrier.wait()
        limiter.wait()
        completed_at.append(time.monotonic())

    threads = [threading.Thread(target=wait_once) for _ in range(3)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=1)

    assert all(not thread.is_alive() for thread in threads)
    completed_at.sort()
    assert completed_at[1] - completed_at[0] >= 0.04
    assert completed_at[2] - completed_at[1] >= 0.04


# ---------------------------------------------------------------------------
# httpx_fetch
# ---------------------------------------------------------------------------


def test_httpx_fetch_success() -> None:
    """httpx_fetch returns FetchResult with content and 200 status."""
    response = _mock_httpx_response(text="<html>test</html>", status_code=200)
    client = _mock_httpx_client(response)

    with patch("app.tools.crawler.httpx.Client", return_value=client):
        result = httpx_fetch("https://example.com")

    assert result.ok is True
    assert result.method_used == "httpx"
    assert result.status_code == 200
    assert result.content == "<html>test</html>"
    assert result.error is None

    # Verify browser headers were sent
    called_headers = client.get.call_args[1]["headers"]
    assert called_headers["User-Agent"] == BROWSER_UA
    assert "Referer" in called_headers
    assert "Accept" in called_headers


def test_httpx_fetch_configures_public_url_hook() -> None:
    response = _mock_httpx_response(text="ok", status_code=200)
    client = _mock_httpx_client(response)

    with patch("app.tools.crawler.httpx.Client", return_value=client) as client_cls:
        httpx_fetch("https://example.com")

    assert client_cls.call_args.kwargs["event_hooks"] == {"request": [validate_public_http_request]}


def test_httpx_fetch_failure_returns_error_result() -> None:
    """httpx_fetch returns FetchResult with error on exception."""
    with patch("app.tools.crawler.httpx.Client") as mock_client_cls:
        mock_client_cls.side_effect = ConnectionError("network down")
        result = httpx_fetch("https://example.com")

    assert result.ok is False
    assert result.method_used == "httpx"
    assert result.status_code == 0
    assert "network down" in result.error
    assert result.content == ""


# ---------------------------------------------------------------------------
# api_fetch
# ---------------------------------------------------------------------------


def test_api_fetch_success() -> None:
    """api_fetch returns FetchResult with JSON content and API headers."""
    response = _mock_httpx_response(text='{"results": []}', status_code=200)
    client = _mock_httpx_client(response)

    with patch("app.tools.crawler.httpx.Client", return_value=client):
        result = api_fetch("https://api.example.com/data")

    assert result.ok is True
    assert result.method_used == "api"
    assert result.status_code == 200
    assert result.content == '{"results": []}'

    # Verify API headers (Accept: application/json, no Referer)
    called_headers = client.get.call_args[1]["headers"]
    assert called_headers["Accept"] == "application/json"
    assert called_headers["User-Agent"] == BROWSER_UA
    assert "Referer" not in called_headers


def test_api_fetch_configures_public_url_hook() -> None:
    response = _mock_httpx_response(text="{}", status_code=200)
    client = _mock_httpx_client(response)

    with patch("app.tools.crawler.httpx.Client", return_value=client) as client_cls:
        api_fetch("https://api.example.com/data")

    assert client_cls.call_args.kwargs["event_hooks"] == {"request": [validate_public_http_request]}


# ---------------------------------------------------------------------------
# playwright_fetch
# ---------------------------------------------------------------------------


def test_playwright_fetch_success() -> None:
    """playwright_fetch returns rendered content with stealth script injected."""
    # Mock playwright context manager chain
    mock_page = MagicMock()
    mock_page.content.return_value = "<html>rendered</html>"
    mock_page.goto.return_value.status = 200

    mock_context = MagicMock()
    mock_context.new_page.return_value = mock_page

    mock_browser = MagicMock()
    mock_browser.new_context.return_value = mock_context

    mock_pw = MagicMock()
    mock_pw.chromium.launch.return_value = mock_browser

    mock_sync_pw = MagicMock()
    mock_sync_pw.__enter__.return_value = mock_pw
    mock_sync_pw.__exit__.return_value = False

    with patch("playwright.sync_api.sync_playwright", return_value=mock_sync_pw):
        result = playwright_fetch("https://example.com/js-heavy")

    assert result.ok is True
    assert result.method_used == "crawl"
    assert result.status_code == 200
    assert result.content == "<html>rendered</html>"

    # Verify stealth script was injected
    mock_context.add_init_script.assert_called_once_with(STEALTH_JS)
    mock_context.route.assert_called_once()
    # Verify networkidle wait
    mock_page.goto.assert_called_once()
    goto_kwargs = mock_page.goto.call_args[1]
    assert goto_kwargs["wait_until"] == "networkidle"


def test_playwright_fetch_preserves_navigation_error_status() -> None:
    """playwright_fetch reports the actual main-document HTTP status."""
    mock_page = MagicMock()
    mock_page.content.return_value = "<html>not found</html>"
    mock_page.goto.return_value.status = 404
    mock_context = MagicMock()
    mock_context.new_page.return_value = mock_page
    mock_browser = MagicMock()
    mock_browser.new_context.return_value = mock_context
    mock_pw = MagicMock()
    mock_pw.chromium.launch.return_value = mock_browser
    mock_sync_pw = MagicMock()
    mock_sync_pw.__enter__.return_value = mock_pw
    mock_sync_pw.__exit__.return_value = False

    with patch("playwright.sync_api.sync_playwright", return_value=mock_sync_pw):
        result = playwright_fetch("https://example.com/missing")

    assert result.status_code == 404
    assert result.ok is False


def test_playwright_fetch_preserves_main_document_headers() -> None:
    mock_response = MagicMock(status=200, headers={"content-type": "text/html"})
    mock_page = MagicMock()
    mock_page.content.return_value = "<html>rendered</html>"
    mock_page.goto.return_value = mock_response
    mock_context = MagicMock()
    mock_context.new_page.return_value = mock_page
    mock_browser = MagicMock()
    mock_browser.new_context.return_value = mock_context
    mock_pw = MagicMock()
    mock_pw.chromium.launch.return_value = mock_browser
    mock_sync_pw = MagicMock()
    mock_sync_pw.__enter__.return_value = mock_pw

    with patch("playwright.sync_api.sync_playwright", return_value=mock_sync_pw):
        result = playwright_fetch("https://example.com/rendered")

    assert result.headers == {"content-type": "text/html"}


def test_playwright_fetch_failure_returns_error_result() -> None:
    """playwright_fetch returns error FetchResult on exception."""
    with patch("playwright.sync_api.sync_playwright") as mock_pw_fn:
        mock_pw_fn.side_effect = Exception("browser launch failed")
        result = playwright_fetch("https://example.com")

    assert result.ok is False
    assert result.method_used == "crawl"
    assert "browser launch failed" in result.error


# ---------------------------------------------------------------------------
# fetch_with_fallback — three-tier chain
# ---------------------------------------------------------------------------


class FakeCrawlerFacade:
    def __init__(
        self,
        *,
        api: FetchResult,
        html: FetchResult,
        browser: FetchResult,
    ) -> None:
        self.results = {
            "api": api,
            "html": html,
            "browser": browser,
        }
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


@pytest.mark.asyncio
async def test_fetch_with_fallback_api_succeeds() -> None:
    """fetch_with_fallback returns API result when tier 1 succeeds."""
    facade = FakeCrawlerFacade(
        api=_result("api", content='{"data": 1}'),
        html=_result("html"),
        browser=_result("browser"),
    )

    result = await fetch_with_fallback(
        "https://api.example.com",
        facade=facade,
        source_name="test",
    )

    assert result.method_used == "api"
    assert result.ok is True
    assert facade.calls == ["api"]
    assert [attempt.method for attempt in result.attempts] == ["api"]
    assert result.attempts[0].status == "succeeded"


@pytest.mark.asyncio
async def test_fetch_with_fallback_httpx_fallback() -> None:
    """fetch_with_fallback falls back to httpx when API fails."""
    facade = FakeCrawlerFacade(
        api=_result("api", status_code=500, error="server error"),
        html=_result("html", content="<html>page</html>"),
        browser=_result("browser"),
    )

    result = await fetch_with_fallback(
        api_url="https://api.example.com",
        page_url="https://example.com",
        source_name="test",
        facade=facade,
    )

    assert result.method_used == "httpx"
    assert result.ok is True
    assert facade.calls == ["api", "html"]
    assert [attempt.status for attempt in result.attempts] == [
        "failed",
        "succeeded",
    ]
    assert result.attempts[0].reason == "server error"
    assert result.attempts[0].fallback_reason == "falling back to html"


@pytest.mark.asyncio
async def test_fetch_with_fallback_crawl_fallback() -> None:
    """fetch_with_fallback falls back to crawl (Playwright) when api+httpx fail."""
    facade = FakeCrawlerFacade(
        api=_result("api", status_code=0, error="api failed"),
        html=_result("html", status_code=0, error="httpx failed"),
        browser=_result("browser", content="<html>rendered</html>"),
    )

    result = await fetch_with_fallback(
        api_url="https://api.example.com",
        page_url="https://example.com",
        source_name="test",
        facade=facade,
    )

    assert result.method_used == "crawl"
    assert result.ok is True
    assert facade.calls == ["api", "html", "browser"]
    assert [attempt.method for attempt in result.attempts] == [
        "api",
        "html",
        "browser",
    ]


@pytest.mark.asyncio
async def test_fetch_with_fallback_rejects_static_success_and_uses_crawl() -> None:
    """A semantic predicate can reject an HTTP 200 shell page."""
    crawl_result = _result(
        "browser",
        content="<html><body>Rendered biomedical record</body></html>",
    )
    facade = FakeCrawlerFacade(
        api=_result("api"),
        html=_result("html", content="<html><div id='app'></div></html>"),
        browser=crawl_result,
    )

    result = await fetch_with_fallback(
        api_url=None,
        page_url="https://example.com",
        source_name="test",
        accept_result=lambda candidate: (
            candidate.method_used == "crawl" and "biomedical" in candidate.content
        ),
        facade=facade,
    )

    assert result is crawl_result
    assert facade.calls == ["html", "browser"]
    assert result.attempts[0].reason == "semantic acceptance predicate rejected result"


@pytest.mark.asyncio
async def test_fetch_with_fallback_all_fail_raises() -> None:
    """fetch_with_fallback raises CrawlError when all tiers fail."""
    facade = FakeCrawlerFacade(
        api=_result("api", status_code=0, error="api failed"),
        html=_result("html", status_code=0, error="httpx failed"),
        browser=_result("browser", status_code=0, error="crawl failed"),
    )

    with pytest.raises(CrawlError, match="All fetch tiers failed") as caught:
        await fetch_with_fallback(
            api_url="https://api.example.com",
            page_url="https://example.com",
            source_name="test",
            facade=facade,
        )

    assert [attempt.method for attempt in caught.value.attempts] == [
        "api",
        "html",
        "browser",
    ]


@pytest.mark.asyncio
async def test_fetch_with_fallback_no_api_url() -> None:
    """fetch_with_fallback skips API tier when api_url is None."""
    facade = FakeCrawlerFacade(
        api=_result("api"),
        html=_result("html", content="<html>page</html>"),
        browser=_result("browser"),
    )

    result = await fetch_with_fallback(
        api_url=None,
        page_url="https://example.com",
        source_name="test",
        facade=facade,
    )

    assert facade.calls == ["html"]
    assert result.method_used == "httpx"


@pytest.mark.asyncio
async def test_host_limiter_does_not_serialize_different_hosts() -> None:
    def clock() -> float:
        return 0.0

    sleeping = asyncio.Event()
    release = asyncio.Event()

    async def sleep(_delay: float) -> None:
        sleeping.set()
        await release.wait()

    limiter = AsyncHostRateLimiter(
        min_interval=1.0,
        clock=clock,
        sleeper=sleep,
    )
    await limiter.wait("https://host-a.example/first")
    blocked_same_host = asyncio.create_task(limiter.wait("https://HOST-A.example/second"))
    await sleeping.wait()
    different_host = asyncio.create_task(limiter.wait("https://host-b.example/first"))
    await asyncio.sleep(0)

    assert different_host.done()
    assert not blocked_same_host.done()

    release.set()
    await blocked_same_host
    await different_host


@pytest.mark.asyncio
async def test_host_limiter_bounds_one_off_host_state() -> None:
    limiter = AsyncHostRateLimiter(
        min_interval=0,
        max_hosts=4,
    )

    for index in range(20):
        await limiter.wait(f"https://host-{index}.example/data")

    assert limiter.tracked_host_count == 4


@pytest.mark.asyncio
async def test_crawler_revalidates_redirect_before_transport(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    validated: list[str] = []
    transported: list[str] = []

    def validate(url: str) -> str:
        validated.append(url)
        if "private.example" in url:
            raise ValueError("private redirect denied")
        return url

    def handler(request: httpx.Request) -> httpx.Response:
        transported.append(str(request.url))
        return httpx.Response(
            302,
            headers={"location": "https://private.example/secret"},
        )

    monkeypatch.setattr(
        "app.tools.crawler.validate_public_http_url",
        validate,
    )
    facade = CrawlerFacade(
        min_interval=0,
        http_transport=httpx.MockTransport(handler),
    )
    result = await facade.api("https://public.example/data")
    await facade.aclose()

    assert not result.ok
    assert "private redirect denied" in (result.error or "")
    assert validated == [
        "https://public.example/data",
        "https://private.example/secret",
    ]
    assert transported == ["https://public.example/data"]


@pytest.mark.asyncio
async def test_crawler_rejects_declared_oversized_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(crawler_module, "MAX_CRAWLER_RESPONSE_BYTES", 8)
    monkeypatch.setattr(
        crawler_module,
        "validate_public_http_url",
        lambda url: url,
    )

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=b"123456789",
            headers={"content-length": "9"},
        )

    facade = CrawlerFacade(
        min_interval=0,
        http_transport=httpx.MockTransport(handler),
    )
    result = await facade.api("https://public.example/data")
    await facade.aclose()

    assert not result.ok
    assert result.content == ""
    assert result.error == "crawler response exceeded 8 byte limit"


@pytest.mark.asyncio
async def test_crawler_rejects_stream_that_exceeds_fixed_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(crawler_module, "MAX_CRAWLER_RESPONSE_BYTES", 8)
    monkeypatch.setattr(
        crawler_module,
        "validate_public_http_url",
        lambda url: url,
    )

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"123456789")

    facade = CrawlerFacade(
        min_interval=0,
        http_transport=httpx.MockTransport(handler),
    )
    result = await facade.html("https://public.example/data")
    await facade.aclose()

    assert not result.ok
    assert result.content == ""
    assert result.error == "crawler response exceeded 8 byte limit"


def test_browser_headers_contain_required_fields() -> None:
    """BROWSER_HEADERS contains User-Agent, Referer, and Accept (project_memory L11)."""
    assert "User-Agent" in BROWSER_HEADERS
    assert "Referer" in BROWSER_HEADERS
    assert "Accept" in BROWSER_HEADERS
    assert "Chrome" in BROWSER_HEADERS["User-Agent"]


def test_stealth_js_hides_webdriver() -> None:
    """STEALTH_JS contains webdriver hiding script (project_memory L12)."""
    assert "webdriver" in STEALTH_JS
    assert "navigator" in STEALTH_JS
