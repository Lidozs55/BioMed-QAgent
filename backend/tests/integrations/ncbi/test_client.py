from __future__ import annotations

from datetime import datetime, timedelta, timezone

import httpx
import pytest

from app.integrations.ncbi.client import (
    AsyncRateLimiter,
    NcbiClientConfig,
    NcbiEutilsClient,
    NcbiRequestError,
    parse_retry_after,
)


def immediate_limiter() -> AsyncRateLimiter:
    now = 0.0

    def clock() -> float:
        return now

    async def sleep(delay: float) -> None:
        nonlocal now
        now += delay

    return AsyncRateLimiter(rate=10, clock=clock, sleeper=sleep)


@pytest.mark.asyncio
async def test_client_sends_required_ncbi_identity_and_query_parameters() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, content=b"{}")

    config = NcbiClientConfig(
        email="developer@example.com",
        tool="BioMedQAgent",
        user_agent="BioMed-QAgent/0.1 (developer@example.com)",
        api_key="secret-key",
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = NcbiEutilsClient(http=http, config=config, limiter=immediate_limiter())
        assert await client.esearch(db="pubmed", term="breast cancer", retmax=20) == b"{}"

    request = requests[0]
    assert request.headers["User-Agent"] == config.user_agent
    assert request.url.params["db"] == "pubmed"
    assert request.url.params["term"] == "breast cancer"
    assert request.url.params["retmax"] == "20"
    assert request.url.params["retmode"] == "json"
    assert request.url.params["tool"] == "BioMedQAgent"
    assert request.url.params["email"] == "developer@example.com"
    assert request.url.params["api_key"] == "secret-key"


@pytest.mark.asyncio
async def test_esummary_and_efetch_preserve_explicit_id_order() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, content=b"response")

    config = NcbiClientConfig(
        email="developer@example.com",
        tool="BioMedQAgent",
        user_agent="BioMed-QAgent/0.1",
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = NcbiEutilsClient(http=http, config=config, limiter=immediate_limiter())
        await client.esummary(db="gds", ids=["3", "1", "2"])
        await client.efetch(db="pubmed", ids=["9", "8"], retmode="xml")

    assert requests[0].url.params["id"] == "3,1,2"
    assert requests[0].url.params["retmode"] == "json"
    assert requests[1].url.params["id"] == "9,8"
    assert requests[1].url.params["retmode"] == "xml"


@pytest.mark.asyncio
async def test_rate_limiter_enforces_three_requests_per_second_without_key() -> None:
    now = 0.0
    delays: list[float] = []

    def clock() -> float:
        return now

    async def sleep(delay: float) -> None:
        nonlocal now
        delays.append(delay)
        now += delay

    limiter = AsyncRateLimiter(rate=3, clock=clock, sleeper=sleep)

    await limiter.acquire()
    await limiter.acquire()
    await limiter.acquire()

    assert delays == pytest.approx([1 / 3, 1 / 3])


def test_default_clients_share_process_limiter_by_quota() -> None:
    without_key = NcbiClientConfig(
        email="developer@example.com", tool="tool", user_agent="agent"
    )
    with_key = NcbiClientConfig(
        email="developer@example.com", tool="tool", user_agent="agent", api_key="key"
    )

    first = NcbiEutilsClient(http=httpx.AsyncClient(), config=without_key)
    second = NcbiEutilsClient(http=httpx.AsyncClient(), config=without_key)
    keyed = NcbiEutilsClient(http=httpx.AsyncClient(), config=with_key)

    assert first.limiter is second.limiter
    assert first.limiter.rate == 3
    assert keyed.limiter.rate == 10


@pytest.mark.asyncio
async def test_client_retries_429_and_5xx_then_returns_response() -> None:
    statuses = iter([429, 503, 200])
    delays: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        status = next(statuses)
        headers = {"Retry-After": "1"} if status == 429 else {}
        return httpx.Response(status, headers=headers, content=b"ok")

    async def sleep(delay: float) -> None:
        delays.append(delay)

    config = NcbiClientConfig(
        email="developer@example.com",
        tool="tool",
        user_agent="agent",
        max_retries=3,
    )
    limiter = AsyncRateLimiter(rate=10, sleeper=lambda _: _completed_sleep())
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = NcbiEutilsClient(
            http=http,
            config=config,
            limiter=limiter,
            sleeper=sleep,
            jitter=lambda: 0.0,
        )
        result = await client.esearch(db="pubmed", term="test", retmax=1)

    assert result == b"ok"
    assert delays == [1.0, 1.0]


async def _completed_sleep() -> None:
    return None


@pytest.mark.asyncio
async def test_client_does_not_retry_non_retryable_400() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(400, content=b"bad request")

    config = NcbiClientConfig(
        email="developer@example.com", tool="tool", user_agent="agent"
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = NcbiEutilsClient(http=http, config=config, limiter=immediate_limiter())
        with pytest.raises(NcbiRequestError) as caught:
            await client.esearch(db="pubmed", term="bad", retmax=1)

    assert calls == 1
    assert caught.value.status_code == 400
    assert caught.value.retryable is False
    assert "bad request" in str(caught.value)


def test_retry_after_parses_seconds_and_http_date() -> None:
    now = datetime(2026, 7, 12, 8, 0, tzinfo=timezone.utc)

    assert parse_retry_after("2", now=now) == 2.0
    assert parse_retry_after(
        "Sun, 12 Jul 2026 08:00:03 GMT", now=now
    ) == 3.0
    assert parse_retry_after("invalid", now=now) == 0.0
