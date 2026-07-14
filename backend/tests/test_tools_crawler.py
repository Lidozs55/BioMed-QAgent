"""Tests for the unified crawler layer — crawler.py and crawl_signal.py.

Tests the three-tier fallback chain (api > httpx > crawl), rate limiter,
and requires_crawl signal mechanism.
"""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest
from app.tools.crawl_signal import (
    check_requires_crawl,
    extract_crawl_target,
    requires_crawl,
    requires_crawl_json,
)
from app.tools.crawler import (
    BROWSER_HEADERS,
    BROWSER_UA,
    STEALTH_JS,
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

    assert client_cls.call_args.kwargs["event_hooks"] == {
        "request": [validate_public_http_request]
    }


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
    response = _mock_httpx_response(
        text='{"results": []}', status_code=200
    )
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

    assert client_cls.call_args.kwargs["event_hooks"] == {
        "request": [validate_public_http_request]
    }


# ---------------------------------------------------------------------------
# playwright_fetch
# ---------------------------------------------------------------------------


def test_playwright_fetch_success() -> None:
    """playwright_fetch returns rendered content with stealth script injected."""
    # Mock playwright context manager chain
    mock_page = MagicMock()
    mock_page.content.return_value = "<html>rendered</html>"
    mock_page.evaluate.return_value = "complete"

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


def test_fetch_with_fallback_api_succeeds() -> None:
    """fetch_with_fallback returns API result when tier 1 succeeds."""
    api_result = FetchResult(
        url="https://api.example.com",
        content='{"data": 1}',
        status_code=200,
        elapsed_ms=50,
        method_used="api",
    )

    with patch("app.tools.crawler.api_fetch", return_value=api_result):
        result = fetch_with_fallback(
            api_url="https://api.example.com",
            page_url="https://example.com",
            source_name="test",
        )

    assert result.method_used == "api"
    assert result.ok is True


def test_fetch_with_fallback_httpx_fallback() -> None:
    """fetch_with_fallback falls back to httpx when API fails."""
    api_result = FetchResult(
        url="https://api.example.com",
        content="",
        status_code=500,
        elapsed_ms=50,
        method_used="api",
        error="server error",
    )
    httpx_result = FetchResult(
        url="https://example.com",
        content="<html>page</html>",
        status_code=200,
        elapsed_ms=100,
        method_used="httpx",
    )

    with patch("app.tools.crawler.api_fetch", return_value=api_result), \
         patch("app.tools.crawler.httpx_fetch", return_value=httpx_result):
        result = fetch_with_fallback(
            api_url="https://api.example.com",
            page_url="https://example.com",
            source_name="test",
        )

    assert result.method_used == "httpx"
    assert result.ok is True


def test_fetch_with_fallback_crawl_fallback() -> None:
    """fetch_with_fallback falls back to crawl (Playwright) when api+httpx fail."""
    api_result = FetchResult(
        url="", content="", status_code=0, elapsed_ms=0,
        method_used="api", error="api failed"
    )
    httpx_result = FetchResult(
        url="", content="", status_code=0, elapsed_ms=0,
        method_used="httpx", error="httpx failed"
    )
    crawl_result = FetchResult(
        url="https://example.com",
        content="<html>rendered</html>",
        status_code=200,
        elapsed_ms=500,
        method_used="crawl",
    )

    with patch("app.tools.crawler.api_fetch", return_value=api_result), \
         patch("app.tools.crawler.httpx_fetch", return_value=httpx_result), \
         patch("app.tools.crawler.playwright_fetch", return_value=crawl_result):
        result = fetch_with_fallback(
            api_url="https://api.example.com",
            page_url="https://example.com",
            source_name="test",
        )

    assert result.method_used == "crawl"
    assert result.ok is True


def test_fetch_with_fallback_all_fail_raises() -> None:
    """fetch_with_fallback raises CrawlError when all tiers fail."""
    api_result = FetchResult(
        url="", content="", status_code=0, elapsed_ms=0,
        method_used="api", error="api failed"
    )
    httpx_result = FetchResult(
        url="", content="", status_code=0, elapsed_ms=0,
        method_used="httpx", error="httpx failed"
    )
    crawl_result = FetchResult(
        url="", content="", status_code=0, elapsed_ms=0,
        method_used="crawl", error="crawl failed"
    )

    with (
        patch("app.tools.crawler.api_fetch", return_value=api_result),
        patch("app.tools.crawler.httpx_fetch", return_value=httpx_result),
        patch("app.tools.crawler.playwright_fetch", return_value=crawl_result),
        pytest.raises(CrawlError, match="All fetch tiers failed"),
    ):
        fetch_with_fallback(
            api_url="https://api.example.com",
            page_url="https://example.com",
            source_name="test",
        )


def test_fetch_with_fallback_no_api_url() -> None:
    """fetch_with_fallback skips API tier when api_url is None."""
    httpx_result = FetchResult(
        url="https://example.com",
        content="<html>page</html>",
        status_code=200,
        elapsed_ms=100,
        method_used="httpx",
    )

    with patch("app.tools.crawler.api_fetch") as mock_api, \
         patch("app.tools.crawler.httpx_fetch", return_value=httpx_result):
        result = fetch_with_fallback(
            api_url=None,
            page_url="https://example.com",
            source_name="test",
        )

    mock_api.assert_not_called()
    assert result.method_used == "httpx"


# ---------------------------------------------------------------------------
# crawl_signal
# ---------------------------------------------------------------------------


def test_requires_crawl_signal_dict() -> None:
    """requires_crawl() returns correct signal dict."""
    signal = requires_crawl(
        source="pubchem",
        reason="API and httpx failed",
        tried_methods=["api", "httpx"],
        target_url="https://pubchem.ncbi.nlm.nih.gov",
    )
    assert signal["status"] == "requires_crawl"
    assert signal["source"] == "pubchem"
    assert signal["reason"] == "API and httpx failed"
    assert signal["tried_methods"] == ["api", "httpx"]
    assert signal["target_url"] == "https://pubchem.ncbi.nlm.nih.gov"


def test_requires_crawl_json_string() -> None:
    """requires_crawl_json() returns valid JSON string."""
    json_str = requires_crawl_json(
        source="tcmsp",
        reason="blocked",
        tried_methods=["api"],
    )
    data = json.loads(json_str)
    assert data["status"] == "requires_crawl"
    assert data["source"] == "tcmsp"


def test_check_requires_crawl_detects_signal() -> None:
    """check_requires_crawl() detects signal in dict and JSON string."""
    # Dict input
    signal_dict = requires_crawl("test", "reason")
    assert check_requires_crawl(signal_dict) is True

    # JSON string input
    signal_json = requires_crawl_json("test", "reason")
    assert check_requires_crawl(signal_json) is True

    # Non-signal dict
    assert check_requires_crawl({"status": "ok"}) is False

    # Non-signal JSON
    assert check_requires_crawl('{"status": "ok"}') is False

    # Invalid JSON
    assert check_requires_crawl("not json") is False


def test_extract_crawl_target() -> None:
    """extract_crawl_target() returns url and source from signal."""
    signal = requires_crawl(
        source="pubchem",
        reason="failed",
        target_url="https://example.com",
    )
    url, source = extract_crawl_target(signal)
    assert url == "https://example.com"
    assert source == "pubchem"

    # Non-signal returns None, None
    url, source = extract_crawl_target({"status": "ok"})
    assert url is None
    assert source is None


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
