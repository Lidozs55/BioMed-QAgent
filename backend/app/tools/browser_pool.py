"""Lifespan-owned asynchronous Playwright browser pool."""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from app.domain.contracts import DataLevel, SourceAsset
from app.subagents.staging import SubagentStagingWorkspace
from app.tools.network_safety import validate_public_http_url

_DEFAULT_VIEWPORT = {"width": 1920, "height": 1080}
_DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)
_STEALTH_SCRIPT = """
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
window.chrome = {runtime: {}};
"""


class BrowserRequestAuthorizer(Protocol):
    """Authorize a browser request before Playwright continues its route."""

    def __call__(self, url: str, *, resource_type: str) -> object: ...


@dataclass(frozen=True, slots=True)
class BrowserFetchResult:
    """Rendered browser response."""

    url: str
    content: str
    status_code: int
    elapsed_ms: float
    headers: dict[str, str]


@dataclass(frozen=True, slots=True)
class BrowserScreenshotResult:
    """Screenshot capture metadata."""

    url: str
    path: Path
    source_asset: SourceAsset
    status_code: int
    elapsed_ms: float


@dataclass(frozen=True, slots=True)
class BrowserActionResult:
    """Result of one declaration-only browser recipe action."""

    content: bytes
    status_code: int
    media_type: str


PlaywrightFactory = Callable[[], Any]


class BrowserSession:
    """One isolated BrowserContext retained across a Recipe action sequence."""

    def __init__(
        self,
        *,
        pool: BrowserPool,
        context: Any,
        page: Any,
    ) -> None:
        self._pool = pool
        self._context = context
        self._page = page
        self._status_code = 0
        self._navigated = False
        self._closed = False

    @property
    def page(self) -> Any:
        return self._page

    async def action(
        self,
        *,
        action: str,
        target: str | None,
        value: str | None,
        current_url: str,
        timeout_seconds: float,
    ) -> BrowserActionResult:
        """Perform one allowlisted declarative browser action."""
        if self._closed:
            raise RuntimeError("browser session is closed")
        timeout_ms = int(timeout_seconds * 1000)
        if action == "navigate":
            destination = value or target or current_url
            if not destination:
                raise ValueError("browser navigate requires a URL")
            response = await self._page.goto(
                destination,
                wait_until="networkidle",
                timeout=timeout_ms,
            )
            self._status_code = response.status if response is not None else 0
            self._navigated = True
            return BrowserActionResult(
                content=b"",
                status_code=self._status_code,
                media_type="text/html",
            )

        if not self._navigated:
            response = await self._page.goto(
                current_url,
                wait_until="networkidle",
                timeout=timeout_ms,
            )
            self._status_code = response.status if response is not None else 0
            self._navigated = True

        if action == "click":
            locator = self._require_locator(target, action)
            await locator.click(timeout=timeout_ms)
            content = b""
            media_type = "text/html"
        elif action == "fill":
            locator = self._require_locator(target, action)
            if value is None:
                raise ValueError("browser fill requires a value")
            await locator.fill(value, timeout=timeout_ms)
            content = b""
            media_type = "text/html"
        elif action == "select":
            locator = self._require_locator(target, action)
            if value is None:
                raise ValueError("browser select requires a value")
            await locator.select_option(value, timeout=timeout_ms)
            content = b""
            media_type = "text/html"
        elif action == "wait_for":
            if target is None:
                raise ValueError("browser wait_for requires a target")
            await self._page.wait_for_selector(
                target,
                state="visible",
                timeout=timeout_ms,
            )
            content = b""
            media_type = "text/html"
        elif action == "extract":
            if target is None:
                content = (await self._page.content()).encode("utf-8")
                media_type = "text/html"
            else:
                text = await self._page.locator(target).inner_text(timeout=timeout_ms)
                content = text.encode("utf-8")
                media_type = "text/plain"
        else:
            raise ValueError(f"unsupported browser action: {action}")

        return BrowserActionResult(
            content=content,
            status_code=self._status_code,
            media_type=media_type,
        )

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            await self._page.close()
        finally:
            try:
                await self._context.close()
            finally:
                await self._pool._end_operation()

    def _require_locator(self, target: str | None, action: str) -> Any:
        if target is None:
            raise ValueError(f"browser {action} requires a target")
        return self._page.locator(target)


class BrowserPool:
    """Share one Chromium while isolating every operation in its own context."""

    def __init__(
        self,
        *,
        max_contexts: int = 4,
        playwright_factory: PlaywrightFactory | None = None,
    ) -> None:
        if max_contexts <= 0:
            raise ValueError("max_contexts must be positive")
        self._max_contexts = max_contexts
        self._playwright_factory = playwright_factory
        self._semaphore = asyncio.Semaphore(max_contexts)
        self._launch_lock = asyncio.Lock()
        self._condition = asyncio.Condition()
        self._playwright_manager: Any | None = None
        self._playwright: Any | None = None
        self._browser: Any | None = None
        self._active_operations = 0
        self._started = False
        self._closed = False

    @property
    def is_started(self) -> bool:
        return self._started

    @property
    def is_closed(self) -> bool:
        return self._closed

    async def start(self) -> None:
        """Make the pool available; Chromium is launched lazily on first use."""
        async with self._launch_lock:
            if self._closed:
                raise RuntimeError("browser pool is closed")
            self._started = True

    async def fetch(
        self,
        url: str,
        *,
        authorize_request: BrowserRequestAuthorizer | None = None,
        wait_until: str = "networkidle",
        timeout: float = 60.0,
        extra_headers: dict[str, str] | None = None,
    ) -> BrowserFetchResult:
        """Render one public page in an isolated context."""
        started_at = time.monotonic()
        authorizer = authorize_request or _authorize_public_request
        async with self._page(
            authorizer=authorizer,
            extra_headers=extra_headers,
        ) as page:
            response = await page.goto(
                url,
                wait_until=wait_until,
                timeout=int(timeout * 1000),
            )
            content = await page.content()
            status_code = response.status if response is not None else 0
            headers = dict(response.headers) if response is not None else {}
        return BrowserFetchResult(
            url=url,
            content=content,
            status_code=status_code,
            elapsed_ms=(time.monotonic() - started_at) * 1000,
            headers=headers,
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
        wait_until: str = "networkidle",
        timeout: float = 60.0,
        extra_headers: dict[str, str] | None = None,
    ) -> BrowserScreenshotResult:
        """Capture a PNG and atomically stage it through the trusted workspace."""
        started_at = time.monotonic()
        authorizer = authorize_request or _authorize_public_request
        async with self._page(
            authorizer=authorizer,
            extra_headers=extra_headers,
        ) as page:
            response = await page.goto(
                url,
                wait_until=wait_until,
                timeout=int(timeout * 1000),
            )
            content = await page.screenshot(
                full_page=full_page,
                timeout=int(timeout * 1000),
            )
            status_code = response.status if response is not None else 0
        source_asset = await asyncio.to_thread(
            workspace.stage_bytes,
            content=content,
            filename=filename,
            source_id=source_id,
            successful_attempt_id=successful_attempt_id,
            data_level=data_level,
            media_type="image/png",
        )
        destination = await asyncio.to_thread(
            workspace.staged_path,
            source_asset,
        )
        return BrowserScreenshotResult(
            url=url,
            path=destination,
            source_asset=source_asset,
            status_code=status_code,
            elapsed_ms=(time.monotonic() - started_at) * 1000,
        )

    async def open_session(
        self,
        *,
        authorize_request: BrowserRequestAuthorizer,
        extra_headers: dict[str, str] | None = None,
    ) -> BrowserSession:
        """Acquire one isolated context for a declaration-only action sequence."""
        await self._begin_operation()
        context: Any | None = None
        page: Any | None = None
        try:
            browser = await self._ensure_browser()
            context = await browser.new_context(
                user_agent=_DEFAULT_USER_AGENT,
                extra_http_headers=extra_headers or {},
                viewport=_DEFAULT_VIEWPORT,
                locale="en-US",
                accept_downloads=False,
            )
            await context.add_init_script(_STEALTH_SCRIPT)
            await context.route(
                "**/*",
                _route_handler(authorize_request),
            )
            page = await context.new_page()
            return BrowserSession(
                pool=self,
                context=context,
                page=page,
            )
        except BaseException:
            try:
                if page is not None:
                    await page.close()
            finally:
                try:
                    if context is not None:
                        await context.close()
                finally:
                    await self._end_operation()
            raise

    async def close(self) -> None:
        """Stop accepting work, drain operations, and close the shared browser."""
        async with self._condition:
            if self._closed:
                return
            self._closed = True
            await self._condition.wait_for(lambda: self._active_operations == 0)

        async with self._launch_lock:
            if self._browser is not None:
                await self._browser.close()
                self._browser = None
            if self._playwright is not None:
                await self._playwright.stop()
                self._playwright = None
            self._playwright_manager = None

    @asynccontextmanager
    async def _page(
        self,
        *,
        authorizer: BrowserRequestAuthorizer,
        extra_headers: dict[str, str] | None,
    ) -> AsyncIterator[Any]:
        session = await self.open_session(
            authorize_request=authorizer,
            extra_headers=extra_headers,
        )
        try:
            yield session.page
        finally:
            await session.close()

    async def _begin_operation(self) -> None:
        await self._semaphore.acquire()
        try:
            async with self._condition:
                if not self._started:
                    raise RuntimeError("browser pool is not started")
                if self._closed:
                    raise RuntimeError("browser pool is closed")
                self._active_operations += 1
        except BaseException:
            self._semaphore.release()
            raise

    async def _end_operation(self) -> None:
        async with self._condition:
            self._active_operations -= 1
            self._condition.notify_all()
        self._semaphore.release()

    async def _ensure_browser(self) -> Any:
        async with self._launch_lock:
            if self._browser is not None:
                return self._browser
            if self._closed:
                raise RuntimeError("browser pool is closed")
            if self._playwright_factory is None:
                from playwright.async_api import async_playwright

                self._playwright_manager = async_playwright()
            else:
                self._playwright_manager = self._playwright_factory()
            self._playwright = await self._playwright_manager.start()
            self._browser = await self._playwright.chromium.launch(headless=True)
            return self._browser


def _route_handler(
    authorizer: BrowserRequestAuthorizer,
) -> Callable[[Any], Any]:
    async def handle(route: Any) -> None:
        request = route.request
        resource_type = _resource_type(request)
        try:
            await asyncio.to_thread(
                authorizer,
                request.url,
                resource_type=resource_type,
            )
        except BaseException:
            await route.abort()
            raise
        await route.continue_()

    return handle


def _resource_type(request: Any) -> str:
    if request.is_navigation_request() and request.frame.parent_frame is None:
        return "main_frame"
    return str(request.resource_type)


def _authorize_public_request(url: str, *, resource_type: str) -> str:
    del resource_type
    return validate_public_http_url(url)
