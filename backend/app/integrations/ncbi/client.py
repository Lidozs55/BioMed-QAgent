"""Shared async policy for NCBI E-utilities requests."""

from __future__ import annotations

import asyncio
import random
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime

import httpx


@dataclass(frozen=True)
class NcbiClientConfig:
    email: str
    tool: str
    user_agent: str
    api_key: str | None = None
    base_url: str = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
    max_retries: int = 3
    total_timeout: float = 60.0

    def __post_init__(self) -> None:
        for field_name in ("email", "tool", "user_agent"):
            if not getattr(self, field_name).strip():
                raise ValueError(f"NCBI {field_name} must not be blank")
        if self.max_retries < 0:
            raise ValueError("max_retries must not be negative")
        if self.total_timeout <= 0:
            raise ValueError("total_timeout must be positive")


class NcbiRequestError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        status_code: int | None,
        retryable: bool,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.retryable = retryable


class AsyncRateLimiter:
    """Serialize request starts to a fixed process-local rate."""

    def __init__(
        self,
        rate: int,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleeper: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        if rate <= 0:
            raise ValueError("rate must be positive")
        self.rate = rate
        self._interval = 1.0 / rate
        self._clock = clock
        self._sleeper = sleeper
        self._lock = asyncio.Lock()
        self._last_started_at: float | None = None

    async def acquire(self) -> None:
        async with self._lock:
            now = self._clock()
            if self._last_started_at is not None:
                delay = self._last_started_at + self._interval - now
                if delay > 0:
                    await self._sleeper(delay)
                    now = self._clock()
            self._last_started_at = now


_PROCESS_LIMITERS = {
    3: AsyncRateLimiter(rate=3),
    10: AsyncRateLimiter(rate=10),
}


def parse_retry_after(value: str | None, *, now: datetime) -> float:
    if not value:
        return 0.0
    try:
        return max(0.0, float(value))
    except ValueError:
        try:
            retry_at = parsedate_to_datetime(value)
        except (TypeError, ValueError, OverflowError):
            return 0.0
        if retry_at.tzinfo is None:
            retry_at = retry_at.replace(tzinfo=UTC)
        return max(0.0, (retry_at - now).total_seconds())


class NcbiEutilsClient:
    def __init__(
        self,
        *,
        http: httpx.AsyncClient,
        config: NcbiClientConfig,
        limiter: AsyncRateLimiter | None = None,
        sleeper: Callable[[float], Awaitable[None]] = asyncio.sleep,
        jitter: Callable[[], float] = random.random,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._http = http
        self.config = config
        quota = 10 if config.api_key else 3
        self.limiter = limiter or _PROCESS_LIMITERS[quota]
        self._sleeper = sleeper
        self._jitter = jitter
        self._now = now
        self._timeout = httpx.Timeout(
            connect=5.0,
            read=30.0,
            write=30.0,
            pool=5.0,
        )

    def _common_params(self) -> dict[str, str]:
        params = {
            "tool": self.config.tool,
            "email": self.config.email,
        }
        if self.config.api_key:
            params["api_key"] = self.config.api_key
        return params

    async def _request(self, endpoint: str, params: dict[str, str]) -> bytes:
        request_params = {**params, **self._common_params()}
        url = f"{self.config.base_url.rstrip('/')}/{endpoint}"
        try:
            async with asyncio.timeout(self.config.total_timeout):
                for attempt in range(self.config.max_retries + 1):
                    await self.limiter.acquire()
                    try:
                        response = await self._http.get(
                            url,
                            params=request_params,
                            headers={"User-Agent": self.config.user_agent},
                            timeout=self._timeout,
                        )
                    except httpx.HTTPError as error:
                        raise NcbiRequestError(
                            f"NCBI request failed: {type(error).__name__}: {error}",
                            status_code=None,
                            retryable=True,
                        ) from error

                    if response.is_success:
                        return response.content

                    retryable = response.status_code == 429 or 500 <= response.status_code < 600
                    if retryable and attempt < self.config.max_retries:
                        retry_after = parse_retry_after(
                            response.headers.get("Retry-After"), now=self._now()
                        )
                        backoff = 0.5 * (2**attempt) + self._jitter()
                        await self._sleeper(max(backoff, retry_after))
                        continue

                    excerpt = response.text[:500]
                    raise NcbiRequestError(
                        f"NCBI returned HTTP {response.status_code}: {excerpt}",
                        status_code=response.status_code,
                        retryable=retryable,
                    )
        except TimeoutError as error:
            raise NcbiRequestError(
                "NCBI request exceeded total timeout",
                status_code=None,
                retryable=True,
            ) from error
        raise RuntimeError("unreachable")

    async def esearch(self, *, db: str, term: str, retmax: int) -> bytes:
        if retmax <= 0:
            raise ValueError("retmax must be positive")
        return await self._request("esearch.fcgi", {
            "db": db,
            "term": term,
            "retmax": str(retmax),
            "retmode": "json",
        })

    async def esummary(self, *, db: str, ids: list[str]) -> bytes:
        if not ids:
            raise ValueError("ids must not be empty")
        return await self._request("esummary.fcgi", {
            "db": db,
            "id": ",".join(ids),
            "retmode": "json",
        })

    async def efetch(self, *, db: str, ids: list[str], retmode: str) -> bytes:
        if not ids:
            raise ValueError("ids must not be empty")
        return await self._request("efetch.fcgi", {
            "db": db,
            "id": ",".join(ids),
            "retmode": retmode,
        })
